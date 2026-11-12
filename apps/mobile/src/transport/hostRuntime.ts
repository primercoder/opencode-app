import {
  base64UrlDecode,
  base64UrlEncode,
  createNoiseInitiator,
  decodeFrame,
  decodeProtectedRecord,
  encodeFrame,
  encodeProtectedRecord,
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
}

export type PairedDevice = {
  id: string
  name: string
  scope: string
}

export type HostSession = {
  host: HostInfo
  opencode: OpencodeInfo
  capabilities: string[]
  lanUrls: string[]
  device?: PairedDevice
  token?: string
}

export type HostCredentials = {
  deviceId: string
  token: string
}

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
  private socket: RuntimeSocket | undefined
  private noise: ReturnType<typeof createNoiseInitiator> | undefined
  private sendCipher: CipherState | undefined
  private receiveCipher: CipherState | undefined
  private stateValue: ConnectionState = "idle"
  private lastErrorValue: HostError | undefined
  private latencyValue: number | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
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

    const failure = errors.at(-1) ?? new HostError("network", "could not connect to host")
    this.lastErrorValue = failure
    if (this.manualClose) throw failure
    this.setState("error")
    if (this.autoReconnect && !this.manualClose && !isFatal(failure)) this.scheduleReconnect()
    throw failure
  }

  private async connectCandidate(url: string): Promise<HostSession> {
    const socket = this.socketFactory(url)
    this.socket = socket
    socket.binaryType = "arraybuffer"
    this.sendCipher = undefined
    this.receiveCipher = undefined
    this.noise = undefined
    this.handshakeQueue.length = 0
    this.handshakeWaiter = undefined
    this.session = undefined

    await waitForOpen(socket, this.connectTimeoutMs)
    if (this.socket !== socket) throw new HostError("network", "connection was cancelled")

    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      void this.handleWire(event.data)
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.handleSocketClosed(new HostError("network", `connection to ${url} failed`))
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.handleSocketClosed(
        new HostError("network", event.reason || "host disconnected", event.code !== undefined ? { status: event.code } : undefined),
      )
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
      case "ping":
        this.sendControl({ t: "pong", id: value.id, ts: value.ts, hostTs: Date.now() })
        return
      case "error":
        this.handleErrorFrame(value)
        return
      default:
        this.emit(value)
    }
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
  const url = new URL(transport.url)
  url.searchParams.set("room", transport.room)
  url.searchParams.set("role", "client")
  url.searchParams.set("v", "1")
  url.searchParams.set("token", transport.clientToken)
  return url.toString()
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
    },
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((item): item is string => typeof item === "string") : [],
    lanUrls: Array.isArray(value.lanUrls) ? value.lanUrls.filter((item): item is string => typeof item === "string") : [],
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
