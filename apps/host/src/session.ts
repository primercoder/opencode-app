import {
  base64UrlDecode,
  base64UrlEncode,
  createNoiseResponder,
  decodeFrame,
  decodeProtectedRecord,
  encodeFrame,
  encodeProtectedRecord,
  type CipherState,
  type NoiseHandshake,
  type OcrpControlFrame,
} from "@ocremote/protocol"
import { addDevice, consumePendingPair, createDevice, findDevice, verifyDeviceToken } from "./pairing.ts"
import { AsrError, type AsrService } from "./asr/service.ts"
import { handleProxyRequest } from "./proxy.ts"
import type { DeviceScope, HostConfig, Identity } from "./config.ts"
import type { OpencodeTarget } from "./opencode.ts"

const PROLOGUE = new TextEncoder().encode("ocremote/1")
const PROTOCOL_VERSION = 1
const HOST_VERSION = "0.1.5"

type AsrRequest = {
  chunks: Uint8Array[]
  bytes: number
  startedAt: number
  modelId?: string
  language?: string
}

export type SessionSocket = {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export type ClientInfo = {
  id: number
  deviceId?: string
  name: string
  platform: string
  scope: DeviceScope
  transport: "direct" | "relay"
  remoteAddress?: string
  connectedAt?: number
  lastSeenAt?: number
}

export type ClientRegistry = {
  register(info: Omit<ClientInfo, "id" | "connectedAt" | "lastSeenAt">): number
  touch(id: number): void
  unregister(id: number): void
}

export type HostContext = {
  identity: Identity
  config: HostConfig
  target: OpencodeTarget
  lanUrls: string[]
  asr: AsrService
  clients: ClientRegistry
  saveConfig(): Promise<void>
  onAuthenticated?(deviceId: string): void
}

export class ConnectionSession {
  private noise: NoiseHandshake | undefined
  private sendCipher: CipherState | undefined
  private receiveCipher: CipherState | undefined
  private deviceId: string | undefined
  private scope: DeviceScope | undefined
  private clientId: number | undefined
  private closed = false
  private readonly aborts = new Map<number, AbortController>()
  private readonly asrRequests = new Map<number, AsrRequest>()
  private static readonly MAX_ASR_BYTES = 5 * 1024 * 1024

  constructor(
    private readonly ws: SessionSocket,
    private readonly ctx: HostContext,
    private readonly transport: { transport: "direct" | "relay"; remoteAddress?: string },
  ) {}

  get handshakeComplete(): boolean {
    return this.sendCipher !== undefined
  }

  onText(message: string): void {
    if (this.closed) return
    if (this.sendCipher) {
      this.fail("PROTOCOL_ERROR", "text frames are not allowed after the handshake")
      return
    }
    let value: { t?: string; message?: string }
    try {
      value = JSON.parse(message) as { t?: string; message?: string }
    } catch {
      this.fail("PROTOCOL_ERROR", "invalid handshake JSON")
      return
    }
    if (value.t !== "noise" || typeof value.message !== "string") {
      this.fail("PROTOCOL_ERROR", "expected a noise handshake frame")
      return
    }

    try {
      this.noise ??= createNoiseResponder({
        localStatic: { publicKey: this.ctx.identity.publicKey, secretKey: this.ctx.identity.secretKey },
        prologue: PROLOGUE,
      })
      this.noise.readMessage(base64UrlDecode(value.message))
      const reply = this.noise.writeMessage(new Uint8Array())
      this.ws.send(JSON.stringify({ t: "noise", message: base64UrlEncode(reply) }))
      if (this.noise.isComplete()) {
        const keys = this.noise.split()
        this.sendCipher = keys.send
        this.receiveCipher = keys.receive
        this.noise = undefined
      }
    } catch (error) {
      this.fail("HANDSHAKE_FAILED", error instanceof Error ? error.message : "handshake failed")
    }
  }

  onBinary(message: Uint8Array): void {
    if (this.closed) return
    if (!this.receiveCipher || !this.sendCipher) {
      this.fail("HANDSHAKE_REQUIRED", "noise handshake is not complete")
      return
    }
    try {
      const record = decodeProtectedRecord(message, this.receiveCipher)
      const frame = decodeFrame(record.data)
      if (frame.kind === "control") void this.handleControl(frame.value)
    } catch (error) {
      this.fail("PROTOCOL_ERROR", error instanceof Error ? error.message : "invalid protected record")
    }
  }

  close(): void {
    this.closed = true
    if (this.clientId !== undefined) {
      this.ctx.clients.unregister(this.clientId)
      this.clientId = undefined
    }
    this.asrRequests.clear()
    for (const controller of this.aborts.values()) controller.abort()
    this.aborts.clear()
  }

  private async handleControl(value: OcrpControlFrame): Promise<void> {
    if (this.clientId !== undefined) this.ctx.clients.touch(this.clientId)
    switch (value.t) {
      case "hello":
        await this.handleHello(value)
        return
      case "req":
        await this.handleRequest(value)
        return
      case "ping":
        this.sendControl({ t: "pong", id: value.id, ts: value.ts, hostTs: Date.now() })
        return
      case "asr.start":
        this.handleAsrStart(value)
        return
      case "asr.chunk":
        this.handleAsrChunk(value)
        return
      case "asr.end":
        await this.handleAsrEnd(value)
        return
      case "asr.cancel":
        this.asrRequests.delete(numberValue(value.id))
        return
      case "cancel": {
        const id = typeof value.id === "number" ? value.id : -1
        this.aborts.get(id)?.abort()
        this.aborts.delete(id)
        return
      }
      default:
        this.sendError("BAD_REQUEST", `unknown control frame: ${value.t}`)
    }
  }

  private async handleHello(value: OcrpControlFrame): Promise<void> {
    if (this.deviceId) {
      this.sendError("BAD_REQUEST", "already authenticated")
      return
    }
    if (value.v !== PROTOCOL_VERSION) {
      this.fail("INCOMPATIBLE", "unsupported protocol version")
      return
    }

    const deviceInfo = value.device as { name?: string; platform?: string } | undefined
    const pair = value.pair as { code?: string; requestedScope?: DeviceScope } | undefined
    if (pair?.code) {
      const scope = consumePendingPair(this.ctx.config, pair.code)
      if (!scope) {
        this.fail("PAIR_CODE_INVALID", "pairing code is invalid or expired")
        return
      }
      const created = createDevice({
        name: deviceInfo?.name ?? "Android device",
        platform: deviceInfo?.platform ?? "android",
        scope,
      })
      addDevice(this.ctx.config, created.device)
      await this.ctx.saveConfig()
      this.deviceId = created.device.id
      this.scope = created.device.scope
      this.clientId = this.ctx.clients.register({
        deviceId: created.device.id,
        name: created.device.name,
        platform: created.device.platform,
        scope: created.device.scope,
        ...this.transport,
      })
      this.ctx.onAuthenticated?.(created.device.id)
      this.sendControl({
        t: "paired",
        ...this.hostInfo(),
        ...(await this.asrInfo()),
        device: { id: created.device.id, name: created.device.name, scope: created.device.scope },
        token: created.token,
      })
      return
    }

    const auth = value.auth as { deviceId?: string; token?: string } | undefined
    if (!auth?.deviceId || !auth.token) {
      this.fail("AUTH_FAILED", "missing device credentials")
      return
    }
    const device = findDevice(this.ctx.config, auth.deviceId)
    if (!device || !verifyDeviceToken(device, auth.token)) {
      this.fail("AUTH_FAILED", "device is not authorized")
      return
    }
    device.lastSeenAt = Date.now()
    await this.ctx.saveConfig()
    this.deviceId = device.id
    this.scope = device.scope
    this.clientId = this.ctx.clients.register({
      deviceId: device.id,
      name: device.name,
      platform: device.platform,
      scope: device.scope,
      ...this.transport,
    })
    this.ctx.onAuthenticated?.(device.id)
    this.sendControl({
      t: "welcome",
      ...this.hostInfo(),
      ...(await this.asrInfo()),
      device: { id: device.id, name: device.name, scope: device.scope },
    })
  }

  private async handleRequest(value: OcrpControlFrame): Promise<void> {
    if (!this.deviceId || !this.scope) {
      this.sendError("AUTH_FAILED", "authenticate before sending requests")
      return
    }
    if (typeof value.id !== "number" || typeof value.method !== "string" || typeof value.path !== "string") {
      this.sendError("BAD_REQUEST", "invalid request frame")
      return
    }
    const controller = new AbortController()
    this.aborts.set(value.id, controller)
    try {
      await handleProxyRequest({
        request: {
          id: value.id,
          method: value.method,
          path: value.path,
          ...(value.headers && typeof value.headers === "object"
            ? { headers: value.headers as Record<string, string> }
            : {}),
          ...(typeof value.body === "string" ? { body: value.body } : {}),
        },
        target: this.ctx.target,
        scope: this.scope,
        signal: controller.signal,
        sender: {
          control: (frame) => {
            if (!controller.signal.aborted) this.sendControl(frame)
          },
          chunk: (id, seq, data) => {
            if (!controller.signal.aborted) this.sendControl({ t: "chunk", id, seq, data })
          },
        },
      })
    } finally {
      this.aborts.delete(value.id)
    }
  }

  private async asrInfo(): Promise<Record<string, unknown>> {
    return {
      asr: {
        host: await this.ctx.asr.capabilities(),
        relay: { available: false, reason: "relay-asr-forbidden" },
      },
    }
  }

  private handleAsrStart(value: OcrpControlFrame): void {
    const id = numberValue(value.id)
    if (id < 0) {
      this.sendAsrError(-1, "ASR_BAD_AUDIO", "invalid ASR request id")
      return
    }
    if (this.asrRequests.size > 0) {
      this.sendAsrError(id, "ASR_BUSY", "another transcription is already active")
      return
    }
    const mime = typeof value.mime === "string" ? value.mime : "audio/wav"
    if (!mime.startsWith("audio/wav") && !mime.startsWith("audio/x-wav")) {
      this.sendAsrError(id, "ASR_BAD_AUDIO", "only 16 kHz mono WAV audio is supported")
      return
    }
    const durationMs = typeof value.durationMs === "number" ? value.durationMs : 0
    if (durationMs > 60_000) {
      this.sendAsrError(id, "ASR_TOO_LARGE", "audio exceeds 60 seconds")
      return
    }
    this.asrRequests.set(id, {
      chunks: [],
      bytes: 0,
      startedAt: Date.now(),
      ...(typeof value.model === "string" ? { modelId: value.model } : {}),
      ...(typeof value.language === "string" ? { language: value.language } : {}),
    })
  }

  private handleAsrChunk(value: OcrpControlFrame): void {
    const id = numberValue(value.id)
    const request = this.asrRequests.get(id)
    if (!request) return
    if (typeof value.data !== "string") {
      this.asrRequests.delete(id)
      this.sendAsrError(id, "ASR_BAD_AUDIO", "invalid audio chunk")
      return
    }
    let chunk: Uint8Array
    try {
      chunk = new Uint8Array(Buffer.from(value.data, "base64"))
    } catch {
      this.asrRequests.delete(id)
      this.sendAsrError(id, "ASR_BAD_AUDIO", "invalid base64 audio chunk")
      return
    }
    request.bytes += chunk.byteLength
    if (request.bytes > ConnectionSession.MAX_ASR_BYTES) {
      this.asrRequests.delete(id)
      this.sendAsrError(id, "ASR_TOO_LARGE", "audio exceeds 5 MiB")
      return
    }
    request.chunks.push(chunk)
  }

  private async handleAsrEnd(value: OcrpControlFrame): Promise<void> {
    const id = numberValue(value.id)
    const request = this.asrRequests.get(id)
    if (!request) {
      this.sendAsrError(id, "ASR_BAD_AUDIO", "ASR request was not started")
      return
    }
    this.asrRequests.delete(id)
    const audio = new Uint8Array(request.bytes)
    let offset = 0
    for (const chunk of request.chunks) {
      audio.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      const result = await this.ctx.asr.transcribe(audio, {
        ...(request.modelId ? { modelId: request.modelId } : {}),
        ...(request.language ? { language: request.language } : {}),
      })
      this.sendControl({
        t: "asr.result",
        id,
        engine: result.engine,
        model: result.model,
        text: result.text,
        ...(result.language ? { language: result.language } : {}),
        segments: result.segments,
        durationMs: result.durationMs,
      })
    } catch (error) {
      const failure = error instanceof AsrError ? error : new AsrError("ASR_FAILED", String(error))
      this.sendAsrError(id, failure.code, failure.message)
    }
  }

  private sendAsrError(id: number, code: string, message: string): void {
    this.sendControl({ t: "asr.error", id, code, message })
  }

  private hostInfo(): Record<string, unknown> {
    return {
      v: PROTOCOL_VERSION,
      host: { id: this.ctx.identity.hostId, name: this.ctx.config.name, version: HOST_VERSION },
      opencode: {
        version: this.ctx.target.version ?? "unknown",
        api: "v2",
        baseUrl: this.ctx.target.url,
      },
      capabilities: ["binary", "sse"],
      lanUrls: this.ctx.lanUrls,
    }
  }

  private sendControl(value: OcrpControlFrame): void {
    if (this.closed || !this.sendCipher) return
    const frame = encodeFrame({ kind: "control", streamId: 0, value })
    this.ws.send(encodeProtectedRecord("binary", frame, this.sendCipher))
  }

  private sendError(code: string, message: string): void {
    this.sendControl({ t: "error", code, message })
  }

  private fail(code: string, message: string): void {
    this.sendError(code, message)
    this.closed = true
    this.ws.close(1008, message.slice(0, 120))
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1
}
