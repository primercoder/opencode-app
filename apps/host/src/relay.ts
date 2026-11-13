import { parseRelayInviteLink as parseSharedInvite, type RelayInvite } from "@ocremote/protocol"
import type { RelayConfig } from "./config.ts"
import type { ConnectionSession, SessionSocket } from "./session.ts"

export type RelayErrorCode =
  | "RELAY_INVITE_INVALID"
  | "RELAY_INVITE_CONSUMED"
  | "RELAY_INVITE_EXPIRED"
  | "RELAY_SUBJECT_INVALID"
  | "RELAY_SUBJECT_REVOKED"
  | "RELAY_ROOM_NOT_FOUND"
  | "RELAY_ROOM_FULL"
  | "RELAY_VERSION"
  | "RELAY_BAD_REQUEST"
  | string

export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "RelayError"
  }
}

export function parseRelayInviteLink(input: string): RelayInvite {
  try {
    return parseSharedInvite(input)
  } catch (error) {
    throw new RelayError("RELAY_INVITE_INVALID", error instanceof Error ? error.message : "relay invite is invalid")
  }
}

export type EnrollRelayInput = {
  link: string
  name?: string
  caPath?: string
}

/**
 * Consumes a one-time relay invite and returns the long-lived host subject.
 * The invite token is never placed in a URL.
 */
export async function enrollRelaySubject(input: EnrollRelayInput): Promise<RelayConfig> {
  const invite = parseRelayInviteLink(input.link)
  if (invite.kind !== "host") {
    throw new RelayError("RELAY_INVITE_INVALID", "this relay invite is for a phone, not a host")
  }
  const socket = createSocket(invite.url, input.caPath)
  socket.binaryType = "arraybuffer"
  try {
    await waitForOpen(socket, 10_000)
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new RelayError("RELAY_BAD_REQUEST", "relay enrollment timed out"))
      }, 10_000)
      const cleanup = () => {
        clearTimeout(timer)
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
      }
      socket.onmessage = (event) => {
        const text = typeof event.data === "string" ? event.data : ""
        const value = parseControl(text)
        if (!value) return
        if (value.t === "relay.error") {
          cleanup()
          reject(new RelayError(stringValue(value.code) || "RELAY_BAD_REQUEST", stringValue(value.message) || "relay enrollment failed"))
          return
        }
        if (value.t === "relay.welcome") {
          cleanup()
          resolve(value)
        }
      }
      socket.onerror = () => {
        cleanup()
        reject(new RelayError("RELAY_BAD_REQUEST", "relay connection failed during enrollment"))
      }
      socket.onclose = () => {
        cleanup()
        reject(new RelayError("RELAY_BAD_REQUEST", "relay closed during enrollment"))
      }
      socket.send(
        JSON.stringify({
          t: "relay.hello",
          v: 2,
          kind: "host",
          invite: invite.invite,
          ...(input.name ? { name: input.name } : {}),
        }),
      )
    })
    const subjectId = stringValue(welcome.subjectId)
    const secret = stringValue(welcome.secret)
    const room = stringValue(welcome.room)
    const clientInvite = stringValue(welcome.clientInvite)
    if (!subjectId || !secret || !room) {
      throw new RelayError("RELAY_BAD_REQUEST", "relay enrollment response is incomplete")
    }
    return {
      url: invite.url,
      room,
      subjectId,
      secret,
      ...(clientInvite ? { clientInvite } : {}),
    }
  } finally {
    try {
      socket.close(1000, "enrolled")
    } catch {
      // ignore
    }
  }
}

export type RelayState = "connecting" | "authenticating" | "open" | "reconnecting" | "closed"

export type RelayHostOptions = {
  config: RelayConfig
  caPath?: string
  createSession(socket: SessionSocket): ConnectionSession
  onState?: (state: RelayState, detail?: string) => void
  /** Called whenever the relay issues a fresh one-time phone invite. */
  onClientInvite?: (link: string) => void
}

type Entry = {
  session: ConnectionSession
  peer: RelayPeer
}

type AuthWaiter = {
  resolve(): void
  reject(error: Error): void
}

type InviteWaiter = {
  promise: Promise<string>
  resolve(link: string): void
  reject(error: Error): void
}

export class RelayHostClient {
  private socket: WebSocket | undefined
  private readonly sessions = new Map<number, Entry>()
  private closed = true
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private authenticated = false
  private authWaiter: AuthWaiter | undefined
  private inviteWaiter: InviteWaiter | undefined
  private readonly caps = new Set<string>()

  constructor(private readonly options: RelayHostOptions) {}

  async start(): Promise<void> {
    this.closed = false
    await this.open()
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.rejectInvite(new RelayError("RELAY_OFFLINE", "relay client is closed"))
    this.closeSessions()
    this.closeSocket()
    this.options.onState?.("closed")
  }

  /**
   * Ask the relay for a fresh one-time phone invite. The pairing offer embeds
   * this link so the phone enrolls without a manually copied admin invite.
   */
  requestClientInvite(timeoutMs = 4_000): Promise<string> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated) {
      return Promise.reject(new RelayError("RELAY_OFFLINE", "relay is not connected"))
    }
    if (!this.caps.has("clientInvite")) {
      return Promise.reject(new RelayError("RELAY_UNSUPPORTED", "relay does not issue phone invites"))
    }
    if (this.inviteWaiter) return this.inviteWaiter.promise

    let resolveLink!: (link: string) => void
    let rejectLink!: (error: Error) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolveLink = resolve
      rejectLink = reject
    })
    const timer = setTimeout(() => {
      waiter.reject(new RelayError("RELAY_TIMEOUT", "relay did not return a phone invite in time"))
    }, timeoutMs)
    const waiter: InviteWaiter = {
      promise,
      resolve: (link) => {
        clearTimeout(timer)
        if (this.inviteWaiter === waiter) this.inviteWaiter = undefined
        this.options.config.clientInvite = link
        this.options.onClientInvite?.(link)
        resolveLink(link)
      },
      reject: (error) => {
        clearTimeout(timer)
        if (this.inviteWaiter === waiter) this.inviteWaiter = undefined
        rejectLink(error)
      },
    }
    this.inviteWaiter = waiter
    socket.send(JSON.stringify({ t: "relay.invite", v: 2, kind: "client" }))
    return promise
  }

  sendFrame(clientId: number, payload: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated) return
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
    const socket = createSocket(this.options.config.url, this.options.caPath)
    socket.binaryType = "arraybuffer"
    this.socket = socket
    this.authenticated = false
    this.caps.clear()

    await waitForOpen(socket, 10_000)
    if (this.socket !== socket || this.closed) {
      socket.close()
      throw new Error("relay connection was cancelled")
    }

    socket.onmessage = (event) => this.handleIncoming(event.data)
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.handleDisconnect("relay connection closed")
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.handleDisconnect("relay connection failed")
    }

    this.options.onState?.("authenticating")
    await this.authenticate(socket)

    this.attempt = 0
    this.options.onState?.("open")
  }

  private authenticate(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.authWaiter = undefined
        reject(new RelayError("RELAY_BAD_REQUEST", "relay authentication timed out"))
      }, 10_000)
      this.authWaiter = {
        resolve: () => {
          clearTimeout(timer)
          this.authWaiter = undefined
          this.authenticated = true
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          this.authWaiter = undefined
          reject(error)
        },
      }
      socket.send(
        JSON.stringify({
          t: "relay.hello",
          v: 2,
          kind: "host",
          subjectId: this.options.config.subjectId,
          secret: this.options.config.secret,
        }),
      )
    })
  }

  private handleIncoming(data: unknown): void {
    if (!this.authenticated) {
      if (typeof data !== "string") return
      const value = parseControl(data)
      if (!value) return
      if (value.t === "relay.error") {
        this.authWaiter?.reject(
          new RelayError(stringValue(value.code) || "RELAY_BAD_REQUEST", stringValue(value.message) || "relay authentication failed"),
        )
        this.handleDisconnect("relay authentication failed")
        return
      }
      if (value.t === "relay.welcome") {
        const room = stringValue(value.room)
        if (room && room !== this.options.config.room) {
          this.options.onState?.("authenticating", `relay room changed to ${room}`)
          this.options.config.room = room
        }
        const clientInvite = stringValue(value.clientInvite)
        if (clientInvite) {
          this.options.config.clientInvite = clientInvite
          this.options.onClientInvite?.(clientInvite)
        }
        if (Array.isArray(value.caps)) {
          this.caps.clear()
          for (const cap of value.caps) {
            if (typeof cap === "string") this.caps.add(cap)
          }
        }
        this.authWaiter?.resolve()
      }
      return
    }
    this.handleMessage(data)
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
    const value = parseControl(text)
    if (!value) return
    if (value.t === "relay.invite") {
      const link = stringValue(value.invite)
      if (link) this.inviteWaiter?.resolve(link)
      else this.inviteWaiter?.reject(new RelayError("RELAY_BAD_REQUEST", "relay returned an empty phone invite"))
      return
    }
    if (value.t === "relay.error" && this.inviteWaiter) {
      this.inviteWaiter.reject(
        new RelayError(
          stringValue(value.code) || "RELAY_BAD_REQUEST",
          stringValue(value.message) || "relay could not issue a phone invite",
        ),
      )
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

  private rejectInvite(error: Error): void {
    this.inviteWaiter?.reject(error)
  }

  private attach(clientId: number): void {
    if (this.sessions.has(clientId)) return
    const peer = new RelayPeer(this, clientId)
    const session = this.options.createSession(peer)
    this.sessions.set(clientId, { session, peer })
  }

  private handleDisconnect(reason: string): void {
    this.authWaiter?.reject(new RelayError("RELAY_BAD_REQUEST", reason))
    this.rejectInvite(new RelayError("RELAY_OFFLINE", reason))
    this.authenticated = false
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

function createSocket(url: string, caPath?: string): WebSocket {
  if (!caPath) return new WebSocket(url)
  // Bun supports a per-socket TLS configuration, so the relay CA never has to
  // be installed system-wide.
  const options = { tls: { ca: Bun.file(caPath) } }
  return new WebSocket(url, options as unknown as string[])
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

function parseControl(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
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
