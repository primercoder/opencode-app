import { encodeBase64 } from "@/lib/base64"
import {
  base64UrlDecode,
  base64UrlEncode,
  createNoiseInitiator,
  decodeFrame,
  decodeProtectedRecord,
  encodeFrame,
  encodeProtectedRecord,
  relayNoiseHandshake,
  type CipherState,
  type OcrpControlFrame,
  type PairingOffer,
  type Transport,
} from "@ocremote/protocol"

const PROLOGUE = new TextEncoder().encode("ocremote/1")
const PROTOCOL_VERSION = 1
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 8_000
const MAX_RECONNECT_DELAY_MS = 15_000

export type ConnectionState = "idle" | "connecting" | "handshaking" | "authenticating" | "ready" | "reconnecting" | "error" | "closed"

export type AppErrorKind = "network" | "auth" | "incompatible" | "http" | "protocol" | "timeout" | "cancelled"

export class HostError extends Error {
  readonly kind: AppErrorKind
  readonly code?: string
  readonly status?: number

  constructor(kind: AppErrorKind, message: string, extra?: { code?: string; status?: number }) {
    super(message)
    this.name = "HostError"
    this.kind = kind
    if (extra?.code !== undefined) this.code = extra.code
    if (extra?.status !== undefined) this.status = extra.status
  }
}

export type HostInfo = {
  id: string
  name: string
  version: string
}

export type OpencodeInfo = {
  version: string
  api: string
  baseUrl?: string
  /** False when the host is up but opencode itself is not running. */
  available?: boolean
  error?: string
}

export type PairedDevice = {
  id: string
  name: string
  scope: string
}

export type HostAsrCapabilities = {
  available: boolean
  engine?: string
  maxAudioSeconds?: number
  streaming?: boolean
  models?: Array<{ id: string; name: string; languages?: string[]; sizeMB?: number; loaded?: boolean }>
}

export type HostSession = {
  host: HostInfo
  opencode: OpencodeInfo
  /** Root directory the phone may browse for new sessions. */
  home?: string
  capabilities: string[]
  lanUrls: string[]
  asr?: {
    host?: HostAsrCapabilities
    relay?: { available: boolean; reason?: string }
  }
  device?: PairedDevice
  token?: string
}

/** Live opencode availability pushed by the host between requests. */
export type OpencodeState = {
  available: boolean
  version?: string
  baseUrl?: string
  error?: string
}

export type AsrResult = {
  text: string
  engine: string
  model?: string
  language?: string
  durationMs: number
  segments?: Array<{ startMs: number; endMs: number; text: string }>
}

export type HostCredentials = {
  deviceId: string
  token: string
}

export type RelayAuth = {
  subjectId: string
  secret: string
  relayKey: string
}

export type RelayAuthResolver = (relayUrl: string) => RelayAuth | undefined

export type HttpResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type RequestInput = {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type StreamInput = Omit<RequestInput, "body"> & {
  onChunk: (text: string) => void
}

export type RuntimeSocket = {
  binaryType: string
  onopen: (() => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export type SocketFactory = (url: string) => RuntimeSocket

export type HostRuntimeOptions = {
  hostId: string
  hostPublicKey: Uint8Array | string
  candidates: string[]
  deviceId?: string
  token?: string
  relayAuth?: RelayAuthResolver
  pairCode?: string
  device?: { name: string; platform: string; appVersion: string }
  autoReconnect?: boolean
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  socketFactory?: SocketFactory
}

type PendingRequest = {
  kind: "request" | "stream"
  status: number
  headers: Record<string, string>
  chunks: string[]
  resolve(value: HttpResponse): void
  reject(error: Error): void
  onChunk?: (text: string) => void
  timer: ReturnType<typeof setTimeout> | null
}

type HandshakeWaiter = {
  resolve(value: string): void
  reject(error: Error): void
}

type AsrWaiter = {
  resolve(value: AsrResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
}

type ConnectWaiter = {
  resolve(value: HostSession): void
  reject(error: Error): void
}

export class HostRuntime {
  readonly hostId: string
  readonly candidates: string[]
  activeCandidate: string | undefined
  credentials: HostCredentials | undefined
  session: HostSession | undefined

  private readonly publicKey: Uint8Array
  private readonly device: { name: string; platform: string; appVersion: string }
  private readonly autoReconnect: boolean
  private readonly connectTimeoutMs: number
  private readonly handshakeTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly socketFactory: SocketFactory

  private pairCode: string | undefined
  private readonly relayAuth: RelayAuthResolver | undefined
  private relayWaiter:
    | { resolve(): void; reject(error: HostError): void; timer: ReturnType<typeof setTimeout> }
    | undefined
  private socket: RuntimeSocket | undefined
  private noise: ReturnType<typeof createNoiseInitiator> | undefined
  private sendCipher: CipherState | undefined
  private receiveCipher: CipherState | undefined
  private stateValue: ConnectionState = "idle"
  private lastErrorValue: HostError | undefined
  private latencyValue: number | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly asrPending = new Map<number, AsrWaiter>()
  private readonly pings = new Map<number, { sentAt: number; timer: ReturnType<typeof setTimeout> }>()
  private readonly handshakeQueue: string[] = []
  private handshakeWaiter: HandshakeWaiter | undefined
  private connectWaiter: ConnectWaiter | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private manualClose = true
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private readonly eventListeners = new Set<(event: unknown) => void>()

  constructor(options: HostRuntimeOptions) {
    this.hostId = options.hostId
    this.candidates = options.candidates.filter((candidate) => candidate.length > 0)
    this.publicKey = typeof options.hostPublicKey === "string" ? base64UrlDecode(options.hostPublicKey) : options.hostPublicKey
    this.pairCode = options.pairCode
    this.relayAuth = options.relayAuth
    this.autoReconnect = options.autoReconnect ?? true
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.device = options.device ?? {
      name: "Android device",
      platform: "android",
      appVersion: "0.0.1",
    }
    if (this.candidates.length === 0) throw new HostError("network", "no connection candidates")
    if (options.deviceId && options.token) {
      this.credentials = { deviceId: options.deviceId, token: options.token }
    }
  }

  static fromPairingOffer(
    offer: PairingOffer,
    options: {
      device?: { name: string; platform: string; appVersion: string }
      autoReconnect?: boolean
      socketFactory?: SocketFactory
      relayAuth?: RelayAuthResolver
    } = {},
  ): HostRuntime {
    return new HostRuntime({
      hostId: offer.hostId,
      hostPublicKey: offer.pk,
      candidates: candidateUrls(offer.transports),
      pairCode: offer.pairCode,
      ...(options.device ? { device: options.device } : {}),
      ...(options.autoReconnect !== undefined ? { autoReconnect: options.autoReconnect } : {}),
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.relayAuth ? { relayAuth: options.relayAuth } : {}),
    })
  }

  get state(): ConnectionState {
    return this.stateValue
  }

  get lastError(): HostError | undefined {
    return this.lastErrorValue
  }

  get latencyMs(): number | undefined {
    return this.latencyValue
  }

  async connect(): Promise<HostSession> {
    this.manualClose = false
    this.reconnectAttempt = 0
    this.clearReconnect()
    return this.runConnect()
  }

  disconnect(): void {
    this.manualClose = true
    this.clearReconnect()
    this.closeSocket()
    const error = new HostError("network", "connection closed")
    this.rejectPending(error)
    this.rejectAsr(error)
    this.rejectHandshake(error)
    if (this.connectWaiter) {
      const waiter = this.connectWaiter
      this.connectWaiter = undefined
      waiter.reject(error)
    }
    this.setState("closed")
  }

  async request(input: RequestInput): Promise<HttpResponse> {
    return this.sendRequest(input, undefined)
  }

  async stream(input: StreamInput): Promise<void> {
    await this.sendRequest(input, input.onChunk)
  }

  async transcribe(input: {
    audio: Uint8Array
    mime?: string
    durationMs: number
    model?: string
    language?: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<AsrResult> {
    if (this.stateValue !== "ready" || !this.sendCipher) throw new HostError("network", "not connected")
    if (input.audio.byteLength === 0) throw new HostError("protocol", "empty audio")
    const id = this.nextId++
    const promise = new Promise<AsrResult>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.asrPending.delete(id)
          this.sendControl({ t: "asr.cancel", id })
          reject(new HostError("timeout", "speech recognition timed out"))
        },
        input.timeoutMs ?? 120_000,
      )
      this.asrPending.set(id, { resolve, reject, timer })
    })

    const onAbort = () => {
      const waiter = this.asrPending.get(id)
      if (!waiter) return
      this.asrPending.delete(id)
      if (waiter.timer) clearTimeout(waiter.timer)
      this.sendControl({ t: "asr.cancel", id })
      waiter.reject(new HostError("cancelled", "speech recognition cancelled"))
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      this.sendControl({
        t: "asr.start",
        id,
        engine: "host",
        mime: input.mime ?? "audio/wav",
        durationMs: input.durationMs,
        ...(input.model ? { model: input.model } : {}),
        ...(input.language ? { language: input.language } : {}),
      })
      const chunkSize = 32 * 1024
      for (let offset = 0; offset < input.audio.byteLength; offset += chunkSize) {
        this.sendControl({
          t: "asr.chunk",
          id,
          data: encodeBase64(input.audio.subarray(offset, offset + chunkSize)),
        })
      }
      this.sendControl({ t: "asr.end", id })
    } catch (error) {
      const waiter = this.asrPending.get(id)
      if (waiter) {
        this.asrPending.delete(id)
        if (waiter.timer) clearTimeout(waiter.timer)
      }
      throw asHostError(error)
    }

    return promise
  }

  updateCandidates(candidates: string[]): void {
    this.candidates.splice(0, this.candidates.length, ...candidates.filter((url) => url.length > 0))
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private async runConnect(): Promise<HostSession> {
    const errors: HostError[] = []
    this.closeSocket()

    for (const candidate of this.candidates) {
      this.setState("connecting")
      try {
        const session = await this.connectCandidate(candidate)
        this.activeCandidate = candidate
        this.reconnectAttempt = 0
        this.setState("ready")
        this.startHeartbeat()
        return session
      } catch (error) {
        const failure = asHostError(error)
        errors.push(failure)
        this.closeSocket()
        if (!this.autoReconnect && isFatal(failure)) break
        if (isFatal(failure)) break
      }
    }

    const failure = errors[errors.length - 1] ?? new HostError("network", "could not connect to host")
    this.lastErrorValue = failure
    if (this.manualClose) throw failure
    this.setState("error")
    if (this.autoReconnect && !this.manualClose && !isFatal(failure)) this.scheduleReconnect()
    throw failure
  }

  private async connectCandidate(candidate: string): Promise<HostSession> {
    const target = parseCandidate(candidate)
    const socket = this.socketFactory(target.url)
    this.socket = socket
    socket.binaryType = "arraybuffer"
    this.sendCipher = undefined
    this.receiveCipher = undefined
    this.noise = undefined
    this.handshakeQueue.length = 0
    this.handshakeWaiter = undefined
    this.session = undefined
    this.relayWaiter = undefined

    await waitForOpen(socket, this.connectTimeoutMs)
    if (this.socket !== socket) throw new HostError("network", "connection was cancelled")

    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      void this.handleWire(event.data)
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.handleSocketClosed(new HostError("network", `connection to ${target.url} failed`))
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.handleSocketClosed(
        new HostError("network", event.reason || "host disconnected", event.code !== undefined ? { status: event.code } : undefined),
      )
    }

    if (target.relay) {
      this.setState("authenticating")
      await this.authenticateRelay(target.url, target.relay.room)
    }

    this.setState("handshaking")

    const noise = createNoiseInitiator({ remoteStatic: this.publicKey, prologue: PROLOGUE })
    this.noise = noise
    const first = noise.writeMessage(new Uint8Array())
    this.sendText(JSON.stringify({ t: "noise", message: base64UrlEncode(first) }))

    const reply = await this.nextHandshakeMessage(this.handshakeTimeoutMs)
    const parsed = parseNoiseMessage(reply)
    noise.readMessage(parsed)
    const keys = noise.split()
    this.sendCipher = keys.send
    this.receiveCipher = keys.receive
    this.noise = undefined

    this.setState("authenticating")
    const hello =
      this.pairCode && !this.credentials
        ? {
            t: "hello",
            v: PROTOCOL_VERSION,
            device: this.deviceMessage(),
            pair: { code: this.pairCode, requestedScope: "full" },
            caps: ["binary", "sse"],
          }
        : {
            t: "hello",
            v: PROTOCOL_VERSION,
            device: this.deviceMessage(),
            auth: { deviceId: this.credentials?.deviceId ?? "", token: this.credentials?.token ?? "" },
            caps: ["binary", "sse"],
          }

    const session = new Promise<HostSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectWaiter = undefined
        reject(new HostError("timeout", "host did not authenticate in time"))
      }, this.handshakeTimeoutMs)
      this.connectWaiter = {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
    this.sendControl(hello)
    return session
  }

  private async authenticateRelay(relayUrl: string, room: string): Promise<void> {
    const credentials = this.relayAuth?.(relayUrl)
    if (!credentials) {
      throw new HostError("auth", "这台手机还没有该中继的访问权限，请先登记中继邀请", {
        code: "RELAY_SUBJECT_MISSING",
      })
    }
    if (!credentials.relayKey) {
      throw new HostError("auth", "中继凭据缺少固定公钥，请重新扫描主机配对码", {
        code: "RELAY_KEY_MISSING",
      })
    }
    const socket = this.socket
    if (!socket) throw new HostError("network", "relay socket is missing", { code: "RELAY_SOCKET_MISSING" })
    const result = await relayNoiseHandshake(
      socket,
      credentials.relayKey,
      {
        t: "relay.hello",
        v: 3,
        kind: "client",
        subjectId: credentials.subjectId,
        secret: credentials.secret,
        room,
      },
      this.handshakeTimeoutMs,
    )
    if (result.welcome.t === "relay.error") {
      const code = stringValue(result.welcome.code) || "RELAY_AUTH_FAILED"
      // Relay v3 uses ROOM_FULL when the room has no live host or has hit
      // capacity. Either condition can clear without new credentials.
      throw new HostError(code === "RELAY_ROOM_FULL" ? "network" : "auth",
        stringValue(result.welcome.message) || "relay authentication failed", { code })
    }
  }

  private handleRelayControl(text: string): void {
    const waiter = this.relayWaiter
    if (!waiter) return
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(value)) return
    if (value.t === "relay.error") {
      waiter.reject(
        new HostError("auth", stringValue(value.message) || "relay authentication failed", {
          code: stringValue(value.code) || "RELAY_AUTH_FAILED",
        }),
      )
      return
    }
    if (value.t === "relay.welcome") {
      waiter.resolve()
    }
  }

  private acceptHandshake(text: string): void {
    if (isRelayControl(text)) return
    const waiter = this.handshakeWaiter
    if (waiter) {
      this.handshakeWaiter = undefined
      waiter.resolve(text)
    } else {
      this.handshakeQueue.push(text)
    }
  }

  private async nextHandshakeMessage(timeoutMs: number): Promise<string> {
    const queued = this.handshakeQueue.shift()
    if (queued) return queued
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiter = undefined
        reject(new HostError("timeout", "noise handshake timed out"))
      }, timeoutMs)
      this.handshakeWaiter = {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

  private async handleWire(data: unknown): Promise<void> {
    if (this.relayWaiter) {
      if (typeof data === "string") this.handleRelayControl(data)
      return
    }
    if (typeof data === "string") {
      if (this.receiveCipher) {
        this.protocolFailure("text frames are not allowed after the handshake")
        return
      }
      this.acceptHandshake(data)
      return
    }

    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    else if (typeof Blob !== "undefined" && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer())
    else {
      this.protocolFailure("unsupported websocket payload")
      return
    }

    if (!this.receiveCipher) {
      // Relay transport delivers host text frames as binary. Accept the Noise
      // handshake reply regardless of the WebSocket frame type.
      this.acceptHandshake(new TextDecoder().decode(bytes))
      return
    }

    try {
      const record = decodeProtectedRecord(bytes, this.receiveCipher)
      const frame = decodeFrame(record.data)
      if (frame.kind === "control") this.handleControl(frame.value)
      else this.emit({ type: "binary", streamId: frame.streamId, data: frame.data })
    } catch (error) {
      this.protocolFailure(error instanceof Error ? error.message : "invalid protected record")
    }
  }

  private handleControl(value: OcrpControlFrame): void {
    switch (value.t) {
      case "welcome":
      case "paired":
        this.handleWelcome(value)
        return
      case "res":
        this.handleResponse(value)
        return
      case "chunk":
        this.handleChunk(value)
        return
      case "end":
        this.finishRequest(value)
        return
      case "err":
        this.failRequest(value)
        return
      case "pong":
        this.handlePong(value)
        return
      case "asr.result":
        this.handleAsrResult(value)
        return
      case "asr.error":
        this.handleAsrError(value)
        return
      case "ping":
        this.sendControl({ t: "pong", id: value.id, ts: value.ts, hostTs: Date.now() })
        return
      case "error":
        this.handleErrorFrame(value)
        return
      case "opencode.state":
        this.handleOpencodeState(value)
        return
      default:
        this.emit(value)
    }
  }

  /**
   * The host pushes availability changes so the workspace can show "host
   * online, opencode offline" immediately instead of waiting for a failed
   * request. It is also emitted as an event so other screens can refresh.
   */
  private handleOpencodeState(value: OcrpControlFrame): void {
    const state = isRecord(value.state) ? value.state : value
    const next: OpencodeState = {
      available: state.available === true,
      ...(typeof state.version === "string" ? { version: state.version } : {}),
      ...(typeof state.baseUrl === "string" ? { baseUrl: state.baseUrl } : {}),
      ...(typeof state.error === "string" ? { error: state.error } : {}),
    }
    if (this.session) {
      const previous = this.session
      const opencode: OpencodeInfo = {
        ...previous.opencode,
        version: next.version ?? previous.opencode.version,
        available: next.available,
        ...(next.baseUrl ? { baseUrl: next.baseUrl } : {}),
        ...(next.error ? { error: next.error } : {}),
      }
      if (!next.error) delete opencode.error
      this.session = { ...previous, opencode }
    }
    this.emit({ type: "host.opencode", state: next })
  }

  private handleWelcome(value: OcrpControlFrame): void {
    const session = parseSession(value)
    this.session = session
    if (value.t === "paired") {
      if (session.device?.id && session.token) {
        this.credentials = { deviceId: session.device.id, token: session.token }
      }
      this.pairCode = undefined
    }
    const waiter = this.connectWaiter
    this.connectWaiter = undefined
    waiter?.resolve(session)
  }

  private handleResponse(value: OcrpControlFrame): void {
    const pending = this.pending.get(numberValue(value.id))
    if (!pending) return
    pending.status = numberValue(value.status)
    pending.headers = isRecord(value.headers) ? stringRecord(value.headers) : {}
  }

  private handleChunk(value: OcrpControlFrame): void {
    const pending = this.pending.get(numberValue(value.id))
    if (!pending) return
    const text = typeof value.data === "string" ? value.data : ""
    if (pending.kind === "stream") pending.onChunk?.(text)
    else pending.chunks.push(text)
  }

  private finishRequest(value: OcrpControlFrame): void {
    const id = numberValue(value.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve({ status: pending.status, headers: pending.headers, body: pending.chunks.join("") })
  }

  private failRequest(value: OcrpControlFrame): void {
    const id = numberValue(value.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    const code = typeof value.code === "string" ? value.code : undefined
    pending.reject(
      new HostError(code?.startsWith("AUTH") ? "auth" : "protocol", typeof value.message === "string" ? value.message : "request failed", {
        ...(code ? { code } : {}),
      }),
    )
  }

  private handleAsrResult(value: OcrpControlFrame): void {
    const id = numberValue(value.id)
    const waiter = this.asrPending.get(id)
    if (!waiter) return
    this.asrPending.delete(id)
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.resolve({
      text: stringValue(value.text),
      engine: stringValue(value.engine),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof value.language === "string" ? { language: value.language } : {}),
      durationMs: numberValue(value.durationMs),
      segments: Array.isArray(value.segments)
        ? value.segments.filter(isRecord).map((segment) => ({
            startMs: numberValue(segment.startMs),
            endMs: numberValue(segment.endMs),
            text: stringValue(segment.text),
          }))
        : [],
    })
  }

  private handleAsrError(value: OcrpControlFrame): void {
    const id = numberValue(value.id)
    const waiter = this.asrPending.get(id)
    if (!waiter) return
    this.asrPending.delete(id)
    if (waiter.timer) clearTimeout(waiter.timer)
    const code = typeof value.code === "string" ? value.code : undefined
    waiter.reject(
      new HostError("protocol", typeof value.message === "string" ? value.message : "speech recognition failed", {
        ...(code ? { code } : {}),
      }),
    )
  }

  private handlePong(value: OcrpControlFrame): void {
    const id = numberValue(value.id)
    const ping = this.pings.get(id)
    if (!ping) return
    clearTimeout(ping.timer)
    this.pings.delete(id)
    this.latencyValue = Date.now() - ping.sentAt
  }

  private handleErrorFrame(value: OcrpControlFrame): void {
    const code = typeof value.code === "string" ? value.code : undefined
    const message = typeof value.message === "string" ? value.message : "host error"
    const failure = new HostError(authCodes.has(code ?? "") ? "auth" : "protocol", message, code ? { code } : undefined)
    this.lastErrorValue = failure
    if (this.stateValue === "authenticating") {
      const waiter = this.connectWaiter
      this.connectWaiter = undefined
      waiter?.reject(failure)
      return
    }
    this.emit(value)
  }

  private async sendRequest(input: RequestInput, onChunk: ((text: string) => void) | undefined): Promise<HttpResponse> {
    const response = new Promise<HttpResponse>((resolve, reject) => {
      if (this.stateValue !== "ready" || !this.sendCipher) {
        reject(new HostError("network", "not connected"))
        return
      }
      const id = this.nextId++
      const timeoutMs = input.timeoutMs ?? this.requestTimeoutMs
      const pending: PendingRequest = {
        kind: onChunk ? "stream" : "request",
        status: 0,
        headers: {},
        chunks: [],
        resolve,
        reject,
        ...(onChunk ? { onChunk } : {}),
        timer: null,
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          this.sendControl({ t: "cancel", id })
          reject(new HostError("timeout", "request timed out"))
        }, timeoutMs)
      }
      this.pending.set(id, pending)

      const onAbort = () => {
        if (!this.pending.delete(id)) return
        if (pending.timer) clearTimeout(pending.timer)
        this.sendControl({ t: "cancel", id })
        reject(new HostError("cancelled", "request cancelled"))
      }
      input.signal?.addEventListener("abort", onAbort, { once: true })

      try {
        this.sendControl({
          t: "req",
          id,
          method: input.method,
          path: input.path,
          headers: input.headers ?? {},
          body: input.body ?? null,
        })
      } catch (error) {
        this.pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        reject(asHostError(error))
      }
    })

    return response
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.stateValue !== "ready") return
      const id = this.nextId++
      const sentAt = Date.now()
      const timer = setTimeout(() => {
        this.pings.delete(id)
        this.handleSocketClosed(new HostError("timeout", "heartbeat timed out"))
        try {
          this.socket?.close(4000, "heartbeat timeout")
        } catch {
          // ignore
        }
      }, this.heartbeatTimeoutMs)
      this.pings.set(id, { sentAt, timer })
      try {
        this.sendControl({ t: "ping", id, ts: sentAt })
      } catch {
        clearTimeout(timer)
        this.pings.delete(id)
      }
    }, this.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const ping of this.pings.values()) clearTimeout(ping.timer)
    this.pings.clear()
  }

  private handleSocketClosed(error: HostError): void {
    if (this.manualClose && this.stateValue !== "reconnecting") {
      this.closeSocket()
      return
    }
    const wasReady = this.stateValue === "ready" || this.stateValue === "reconnecting"
    this.closeSocket()
    this.rejectPending(error)
    this.rejectAsr(error)
    if (this.connectWaiter) {
      const waiter = this.connectWaiter
      this.connectWaiter = undefined
      waiter.reject(error)
    }
    this.rejectHandshake(error)
    if (!wasReady) return

    this.lastErrorValue = error
    if (this.autoReconnect) {
      this.setState("reconnecting")
      this.scheduleReconnect()
    } else {
      this.setState("error")
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delay = Math.min(1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 4), MAX_RECONNECT_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.manualClose) return
      this.setState("reconnecting")
      void this.runConnect().catch(() => {
        // runConnect schedules the next attempt.
      })
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private rejectHandshake(error: HostError): void {
    const waiter = this.handshakeWaiter
    this.handshakeWaiter = undefined
    waiter?.reject(error)
  }

  private rejectAsr(error: HostError): void {
    for (const waiter of this.asrPending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.asrPending.clear()
  }

  private rejectPending(error: HostError): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private protocolFailure(message: string): void {
    const error = new HostError("protocol", message)
    this.lastErrorValue = error
    if (this.connectWaiter) {
      const waiter = this.connectWaiter
      this.connectWaiter = undefined
      waiter.reject(error)
    }
    this.rejectHandshake(error)
    this.rejectPending(error)
    this.closeSocket()
    this.setState("error")
    if (this.autoReconnect && !this.manualClose) this.scheduleReconnect()
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = undefined
    this.stopHeartbeat()
    if (this.relayWaiter) {
      const waiter = this.relayWaiter
      this.relayWaiter = undefined
      clearTimeout(waiter.timer)
      waiter.reject(new HostError("network", "relay connection closed"))
    }
    if (!socket) return
    socket.onopen = null
    socket.onerror = null
    socket.onclose = null
    socket.onmessage = null
    try {
      socket.close(1000, "client closed")
    } catch {
      // ignore
    }
  }

  private sendText(text: string): void {
    if (!this.socket) throw new HostError("network", "socket is not connected")
    this.socket.send(text)
  }

  private sendControl(value: OcrpControlFrame): void {
    if (!this.socket || !this.sendCipher) throw new HostError("network", "not connected")
    const frame = encodeFrame({ kind: "control", streamId: 0, value })
    this.socket.send(encodeProtectedRecord("binary", frame, this.sendCipher))
  }

  private deviceMessage(): { id?: string; name: string; platform: string; appVersion: string } {
    return {
      ...(this.credentials?.deviceId ? { id: this.credentials.deviceId } : {}),
      name: this.device.name,
      platform: this.device.platform,
      appVersion: this.device.appVersion,
    }
  }

  private setState(state: ConnectionState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    for (const listener of this.stateListeners) listener(state)
  }

  private emit(event: unknown): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

const authCodes = new Set(["AUTH_FAILED", "PAIR_CODE_INVALID", "HANDSHAKE_FAILED"])

function isFatal(error: HostError): boolean {
  return error.kind === "auth" || error.kind === "incompatible" || error.kind === "protocol"
}

function asHostError(error: unknown): HostError {
  if (error instanceof HostError) return error
  return new HostError("network", error instanceof Error ? error.message : "connection failed")
}

export function candidateUrls(transports: Transport[]): string[] {
  return [...transports]
    .sort((left, right) => left.priority - right.priority)
    .map((transport) => candidateUrl(transport))
    .filter((url): url is string => Boolean(url))
}

function candidateUrl(transport: Transport): string {
  if (transport.kind !== "relay") return transport.url
  // The relay URL itself stays clean; the descriptor carries the room so the
  // runtime can run first-frame relay authentication before Noise.
  const url = new URL(transport.url)
  url.searchParams.set("relay", "1")
  url.searchParams.set("room", transport.room)
  return url.toString()
}

function parseCandidate(candidate: string): { url: string; relay?: { room: string } } {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { url: candidate }
  }
  if (url.searchParams.get("relay") !== "1") return { url: candidate }
  const room = url.searchParams.get("room") ?? ""
  url.searchParams.delete("relay")
  url.searchParams.delete("room")
  return { url: url.toString(), relay: { room } }
}

function waitForOpen(socket: RuntimeSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new HostError("timeout", "websocket connect timed out"))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.onopen = null
      socket.onerror = null
      socket.onclose = null
    }
    socket.onopen = () => {
      cleanup()
      resolve()
    }
    socket.onerror = () => {
      cleanup()
      reject(new HostError("network", "websocket connection failed"))
    }
    socket.onclose = () => {
      cleanup()
      reject(new HostError("network", "websocket closed during connect"))
    }
  })
}

function isRelayControl(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) && value.t === "welcome" && typeof value.clientId === "number"
  } catch {
    return false
  }
}

function parseNoiseMessage(text: string): Uint8Array {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HostError("protocol", "invalid noise handshake JSON")
  }
  if (!isRecord(parsed) || parsed.t !== "noise" || typeof parsed.message !== "string") {
    throw new HostError("protocol", "expected a noise handshake message")
  }
  try {
    return base64UrlDecode(parsed.message)
  } catch {
    throw new HostError("protocol", "invalid noise handshake payload")
  }
}

function parseSession(value: OcrpControlFrame): HostSession {
  const host = isRecord(value.host) ? value.host : {}
  const opencode = isRecord(value.opencode) ? value.opencode : {}
  const device = isRecord(value.device)
    ? {
        id: stringValue(value.device.id),
        name: stringValue(value.device.name),
        scope: stringValue(value.device.scope),
      }
    : undefined
  return {
    host: {
      id: stringValue(host.id),
      name: stringValue(host.name),
      version: stringValue(host.version),
    },
    opencode: {
      version: stringValue(opencode.version),
      api: stringValue(opencode.api),
      ...(typeof opencode.baseUrl === "string" ? { baseUrl: opencode.baseUrl } : {}),
      ...(typeof opencode.available === "boolean" ? { available: opencode.available } : {}),
      ...(typeof opencode.error === "string" ? { error: opencode.error } : {}),
    },
    ...(typeof value.home === "string" ? { home: value.home } : {}),
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((item): item is string => typeof item === "string") : [],
    lanUrls: Array.isArray(value.lanUrls) ? value.lanUrls.filter((item): item is string => typeof item === "string") : [],
    ...(isRecord(value.asr)
      ? {
          asr: {
            ...(isRecord(value.asr.host)
              ? {
                  host: {
                    available: value.asr.host.available === true,
                    ...(typeof value.asr.host.engine === "string" ? { engine: value.asr.host.engine } : {}),
                    ...(typeof value.asr.host.maxAudioSeconds === "number"
                      ? { maxAudioSeconds: value.asr.host.maxAudioSeconds }
                      : {}),
                    ...(typeof value.asr.host.streaming === "boolean" ? { streaming: value.asr.host.streaming } : {}),
                    ...(Array.isArray(value.asr.host.models)
                      ? {
                          models: value.asr.host.models.filter(isRecord).map((model) => ({
                            id: stringValue(model.id),
                            name: stringValue(model.name),
                            ...(Array.isArray(model.languages)
                              ? { languages: model.languages.filter((item): item is string => typeof item === "string") }
                              : {}),
                            ...(typeof model.sizeMB === "number" ? { sizeMB: model.sizeMB } : {}),
                            ...(typeof model.loaded === "boolean" ? { loaded: model.loaded } : {}),
                          })),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(isRecord(value.asr.relay)
              ? {
                  relay: {
                    available: value.asr.relay.available === true,
                    ...(typeof value.asr.relay.reason === "string" ? { reason: value.asr.relay.reason } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(device ? { device } : {}),
    ...(typeof value.token === "string" ? { token: value.token } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : -1
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item
  }
  return result
}

function defaultSocketFactory(url: string): RuntimeSocket {
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  return socket as unknown as RuntimeSocket
}
