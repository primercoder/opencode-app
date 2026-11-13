import { randomBytes } from "node:crypto"
import { base64UrlEncode } from "@ocremote/protocol"
import type { RelayConfig } from "./config.ts"
import type { ConnectionSession, SessionSocket } from "./session.ts"

export type RegisterRelayInput = {
  relayUrl: string
  secret?: string
  room?: string
  hostToken?: string
  clientToken?: string
  ttlSeconds?: number
}

export async function registerRelayRoom(input: RegisterRelayInput): Promise<RelayConfig> {
  const room = input.room ?? `room_${randomBytes(8).toString("hex")}`
  const hostToken = input.hostToken ?? base64UrlEncode(randomBytes(32))
  const clientToken = input.clientToken ?? base64UrlEncode(randomBytes(32))
  const registration = new URL(input.relayUrl)
  registration.protocol = registration.protocol === "wss:" ? "https:" : "http:"
  registration.pathname = "/v1/rooms"
  registration.search = ""
  registration.hash = ""

  let response: Response
  try {
    response = await fetch(registration, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.secret ? { authorization: `Bearer ${input.secret}` } : {}),
      },
      body: JSON.stringify({
        room,
        hostToken,
        clientToken,
        ...(input.ttlSeconds ? { ttl: input.ttlSeconds } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error(
      `cannot reach relay ${input.relayUrl}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`relay room registration failed with HTTP ${response.status}${body ? `: ${body}` : ""}`)
  }

  const payload = (await response.json()) as { wsUrl?: unknown }
  return {
    url: typeof payload.wsUrl === "string" && payload.wsUrl.length > 0 ? payload.wsUrl : input.relayUrl,
    room,
    hostToken,
    clientToken,
  }
}

export type RelayState = "connecting" | "open" | "reconnecting" | "closed"

export type RelayHostOptions = {
  config: RelayConfig
  createSession(socket: SessionSocket): ConnectionSession
  onState?: (state: RelayState, detail?: string) => void
  /** Recreate the in-memory relay room before a reconnect (e.g. after relay restart). */
  onBeforeReconnect?: () => Promise<void>
}

type Entry = {
  session: ConnectionSession
  peer: RelayPeer
}

export class RelayHostClient {
  private socket: WebSocket | undefined
  private readonly sessions = new Map<number, Entry>()
  private closed = true
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: RelayHostOptions) {}

  async start(): Promise<void> {
    this.closed = false
    await this.open()
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.closeSessions()
    this.closeSocket()
    this.options.onState?.("closed")
  }

  sendFrame(clientId: number, payload: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const frame = new Uint8Array(4 + payload.byteLength)
    writeU32(frame, 0, clientId)
    frame.set(payload, 4)
    socket.send(frame)
  }

  drop(clientId: number): void {
    this.sessions.delete(clientId)
  }

  private async open(): Promise<void> {
    if (this.closed) throw new Error("relay client is closed")
    this.options.onState?.("connecting")
    const socket = new WebSocket(relaySocketUrl(this.options.config))
    socket.binaryType = "arraybuffer"
    this.socket = socket

    await waitForOpen(socket, 10_000)
    if (this.socket !== socket || this.closed) {
      socket.close()
      throw new Error("relay connection was cancelled")
    }

    socket.onmessage = (event) => this.handleMessage(event.data)
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.handleDisconnect("relay connection closed")
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.handleDisconnect("relay connection failed")
    }

    this.attempt = 0
    this.options.onState?.("open")
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      this.handleControl(data)
      return
    }

    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    else return
    if (bytes.byteLength < 4) return

    const clientId = readU32(bytes, 0)
    const entry = this.sessions.get(clientId)
    if (!entry) return
    const payload = bytes.subarray(4)
    if (entry.session.handshakeComplete) entry.session.onBinary(payload)
    else entry.session.onText(new TextDecoder().decode(payload))
  }

  private handleControl(text: string): void {
    let value: { t?: string; clientId?: number }
    try {
      value = JSON.parse(text) as { t?: string; clientId?: number }
    } catch {
      return
    }
    if (typeof value.clientId !== "number") return
    if (value.t === "peer") {
      this.attach(value.clientId)
      return
    }
    if (value.t === "peer.left") {
      const entry = this.sessions.get(value.clientId)
      if (!entry) return
      this.sessions.delete(value.clientId)
      entry.session.close()
      return
    }
  }

  private attach(clientId: number): void {
    if (this.sessions.has(clientId)) return
    const peer = new RelayPeer(this, clientId)
    const session = this.options.createSession(peer)
    this.sessions.set(clientId, { session, peer })
  }

  private handleDisconnect(reason: string): void {
    this.closeSessions()
    this.closeSocket()
    if (this.closed) return
    this.options.onState?.("reconnecting", reason)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return
    this.attempt += 1
    const delay = Math.min(500 * 2 ** Math.min(this.attempt - 1, 4), 10_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    try {
      await this.options.onBeforeReconnect?.()
      await this.open()
    } catch {
      this.scheduleReconnect()
    }
  }

  private closeSessions(): void {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    for (const entry of entries) {
      entry.peer.markClosed()
      entry.session.close()
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(1000, "host closed")
    } catch {
      // ignore
    }
  }
}

class RelayPeer implements SessionSocket {
  private closed = false

  constructor(
    private readonly client: RelayHostClient,
    private readonly clientId: number,
  ) {}

  send(data: string | Uint8Array): void {
    if (this.closed) return
    this.client.sendFrame(this.clientId, typeof data === "string" ? new TextEncoder().encode(data) : data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.client.drop(this.clientId)
  }

  markClosed(): void {
    this.closed = true
  }
}

function relaySocketUrl(config: RelayConfig): string {
  const url = new URL(config.url)
  url.searchParams.set("room", config.room)
  url.searchParams.set("role", "host")
  url.searchParams.set("v", "1")
  url.searchParams.set("token", config.hostToken)
  return url.toString()
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("relay websocket connect timed out"))
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
      reject(new Error("relay websocket connection failed"))
    }
    socket.onclose = () => {
      cleanup()
      reject(new Error("relay websocket closed during connect"))
    }
  })
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0
}
