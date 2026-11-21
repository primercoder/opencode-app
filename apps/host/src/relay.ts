import {
  decodeRelayControl,
  encodeRelayControl,
  parseRelayInviteLink as parseSharedInvite,
  relayNoiseHandshake,
  type CipherState,
  type RelayInvite,
} from "@ocremote/protocol"
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

export const DEFAULT_RELAY_HOST = "118.31.124.193"
export const DEFAULT_RELAY_PORT = 8443
export const DEFAULT_RELAY_ADDRESS = `${DEFAULT_RELAY_HOST}:${DEFAULT_RELAY_PORT}`
export const DEFAULT_RELAY_URL = `ws://${DEFAULT_RELAY_HOST}:${DEFAULT_RELAY_PORT}/ws`

export type RelayAddress = {
  url: string
  host: string
  port: number
  tls: boolean
  /** Present only for a legacy ocremote-relay://host# link. */
  legacyKey?: string
  legacyInvite?: string
}

export type RelayProfile = {
  url: string
  relayKey: string
  relayId?: string
}

type RelayInfoResponse = {
  relayId?: string
  wsUrl?: string
  relayPublicKey?: string
}

/**
 * Accepts an IP:port, a bare host, a ws(s) URL, or a legacy host link.
 * The normal case is now just `118.31.124.193:8443`.
 */
export function parseRelayAddress(input: string): RelayAddress {
  const value = input.trim() || DEFAULT_RELAY_ADDRESS
  if (value.startsWith("ocremote-relay://")) {
    const invite = parseRelayInviteLink(value)
    if (invite.kind !== "host") {
      throw new RelayError("RELAY_INVITE_INVALID", "this relay link is for a phone, not a host")
    }
    const url = new URL(invite.url)
    return {
      url: invite.url,
      host: url.hostname,
      port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
      tls: url.protocol === "wss:",
      legacyKey: invite.rk,
      ...(invite.invite ? { legacyInvite: invite.invite } : {}),
    }
  }

  let candidate = value
  if (candidate.startsWith("http://")) candidate = `ws://${candidate.slice("http://".length)}`
  else if (candidate.startsWith("https://")) candidate = `wss://${candidate.slice("https://".length)}`
  else if (!/^wss?:\/\//u.test(candidate)) {
    const host = candidate.includes(":") || candidate.includes("]") ? candidate : `${candidate}:${DEFAULT_RELAY_PORT}`
    candidate = `ws://${host}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new RelayError("RELAY_BAD_REQUEST", `invalid relay address: ${input}`)
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new RelayError("RELAY_BAD_REQUEST", "relay address must use ws:// or wss://")
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws"
  const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RelayError("RELAY_BAD_REQUEST", `invalid relay port: ${url.port}`)
  }
  return { url: url.toString(), host: url.hostname, port, tls: url.protocol === "wss:" }
}

export function sameRelayUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return left === right
  }
}

async function fetchRelayInfo(address: RelayAddress, caPath?: string): Promise<RelayInfoResponse> {
  const infoUrl = new URL(address.url)
  infoUrl.protocol = address.tls ? "https:" : "http:"
  infoUrl.pathname = "/v1/info"
  infoUrl.search = ""
  infoUrl.hash = ""
  const options = {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
    ...(caPath ? { tls: { ca: Bun.file(caPath) } } : {}),
  } as RequestInit & { tls?: { ca: unknown } }
  let response: Response
  try {
    response = await fetch(infoUrl, options)
  } catch (error) {
    throw new RelayError(
      "RELAY_NETWORK",
      `cannot reach relay ${address.host}:${address.port}: ${error instanceof Error ? error.message : "network error"}`,
    )
  }
  if (!response.ok) {
    throw new RelayError("RELAY_INFO_INVALID", `relay /v1/info returned HTTP ${response.status}`)
  }
  const payload = (await response.json().catch(() => undefined)) as RelayInfoResponse | undefined
  if (!payload || typeof payload.relayPublicKey !== "string" || payload.relayPublicKey.length < 32) {
    throw new RelayError("RELAY_INFO_INVALID", "relay /v1/info did not return a relay public key")
  }
  return payload
}

export async function resolveRelayProfile(input: {
  address: string
  saved?: RelayConfig
  caPath?: string
  refreshKey?: boolean
  /** Fetch /v1/info even when a saved key exists, to detect identity changes. */
  probe?: boolean
}): Promise<RelayProfile & { legacyInvite?: string }> {
  const address = parseRelayAddress(input.address)
  if (address.legacyKey) {
    return {
      url: address.url,
      relayKey: address.legacyKey,
      ...(address.legacyInvite ? { legacyInvite: address.legacyInvite } : {}),
    }
  }
  if (
    input.saved &&
    sameRelayUrl(input.saved.url, address.url) &&
    input.saved.relayKey &&
    !input.refreshKey &&
    !input.probe
  ) {
    return {
      url: input.saved.url,
      relayKey: input.saved.relayKey,
      ...(input.saved.relayId ? { relayId: input.saved.relayId } : {}),
    }
  }

  const info = await fetchRelayInfo(address, input.caPath)
  const key = info.relayPublicKey
  if (!key) throw new RelayError("RELAY_INFO_INVALID", "relay public key is missing")
  const infoUrl = typeof info.wsUrl === "string" && /^wss?:\/\//u.test(info.wsUrl) ? info.wsUrl : address.url
  if (input.saved && input.saved.relayKey && !input.refreshKey && input.saved.relayKey !== key) {
    throw new RelayError(
      "RELAY_KEY_CHANGED",
      `relay identity changed for ${address.host}:${address.port}; confirm the server and retry with --refresh-key`,
    )
  }
  return {
    url: infoUrl,
    relayKey: key,
    ...(info.relayId ? { relayId: info.relayId } : {}),
  }
}

export type EnrollRelayInput = {
  profile: RelayProfile & { legacyInvite?: string }
  hostId: string
  name?: string
  hostPublicKey?: string
  caPath?: string
}

/**
 * Registers this host with a relay. The relay address and pinned key come from
 * /v1/info; no long host link is required.
 */
export async function enrollRelaySubject(input: EnrollRelayInput): Promise<RelayConfig> {
  if (!input.hostId) {
    throw new RelayError("RELAY_BAD_REQUEST", "host identity is missing")
  }
  if (!input.profile.relayKey) {
    throw new RelayError("RELAY_INFO_INVALID", "relay public key is missing")
  }
  const socket = createSocket(input.profile.url, input.caPath)
  socket.binaryType = "arraybuffer"
  try {
    await waitForOpen(socket, 10_000)
    const result = await relayNoiseHandshake(
      socket,
      input.profile.relayKey,
      {
        t: "relay.hello",
        v: 3,
        kind: "host",
        hostId: input.hostId,
        ...(input.name ? { hostName: input.name } : {}),
        ...(input.hostPublicKey ? { hostPublicKey: input.hostPublicKey } : {}),
        ...(input.profile.legacyInvite ? { invite: input.profile.legacyInvite } : {}),
      },
      10_000,
    )
    const welcome = result.welcome
    if (welcome.t === "relay.error") {
      throw new RelayError(
        stringValue(welcome.code) || "RELAY_BAD_REQUEST",
        stringValue(welcome.message) || "relay enrollment failed",
      )
    }
    const subjectId = stringValue(welcome.subjectId)
    const secret = stringValue(welcome.secret)
    const room = stringValue(welcome.room)
    if (!subjectId || !secret || !room) {
      throw new RelayError("RELAY_BAD_REQUEST", "relay enrollment response is incomplete")
    }
    return {
      url: input.profile.url,
      room,
      subjectId,
      secret,
      relayKey: input.profile.relayKey,
      ...(input.profile.relayId ? { relayId: input.profile.relayId } : {}),
      enabled: true,
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
}

type Entry = {
  session: ConnectionSession
  peer: RelayPeer
}

type InviteWaiter = {
  id: string
  promise: Promise<string>
  resolve(link: string): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class RelayHostClient {
  private socket: WebSocket | undefined
  private readonly sessions = new Map<number, Entry>()
  private closed = true
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private authenticated = false
  private sendCipher: CipherState | undefined
  private receiveCipher: CipherState | undefined
  private readonly inviteRequests = new Map<string, InviteWaiter>()
  private inviteSeq = 0
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
    this.rejectAllInvites(new RelayError("RELAY_OFFLINE", "relay client is closed"))
    this.closeSessions()
    this.closeSocket()
    this.options.onState?.("closed")
  }

  /**
   * Ask the relay for one fresh, pair-specific phone invite. Each call sends a
   * distinct request id so concurrent or repeated pair commands never share a
   * link. No invite is requested at startup or reconnect time.
   */
  requestClientInvite(timeoutMs = 4_000): Promise<string> {
    if (!this.caps.has("clientInvite")) {
      return Promise.reject(new RelayError("RELAY_UNSUPPORTED", "relay does not issue phone invites"))
    }
    return this.requestLink(
      (id) => ({ t: "relay.invite", v: 3, kind: "client", id }),
      timeoutMs,
      "relay did not return a phone invite in time",
    )
  }

  /**
   * Publishes the full pairing offer on the relay and returns the short URL
   * that belongs in the QR code. A relay-only offer embeds a ~300 character
   * enrollment link, which makes the QR grow past 100 modules and wrap in an
   * 80-column terminal; a short URL keeps it at 29 modules.
   */
  publishPairOffer(offer: string, timeoutMs = 4_000): Promise<string> {
    if (!this.caps.has("pairShorten")) {
      return Promise.reject(new RelayError("RELAY_UNSUPPORTED", "relay cannot shorten pairing offers"))
    }
    return this.requestLink(
      (id) => ({ t: "relay.pair", v: 3, id, offer }),
      timeoutMs,
      "relay did not publish the pairing offer in time",
    )
  }

  private requestLink(
    frame: (id: string) => Record<string, unknown>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<string> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated) {
      return Promise.reject(new RelayError("RELAY_OFFLINE", "relay is not connected"))
    }
    if (!this.sendCipher) {
      return Promise.reject(new RelayError("RELAY_OFFLINE", "relay is not authenticated"))
    }

    const id = `pair-${Date.now()}-${++this.inviteSeq}`
    let resolveLink!: (link: string) => void
    let rejectLink!: (error: Error) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolveLink = resolve
      rejectLink = reject
    })
    const waiter: InviteWaiter = {
      id,
      promise,
      timer: setTimeout(() => {
        this.rejectInvite(id, new RelayError("RELAY_TIMEOUT", timeoutMessage))
      }, timeoutMs),
      resolve: (link) => {
        clearTimeout(waiter.timer)
        this.inviteRequests.delete(id)
        resolveLink(link)
      },
      reject: (error) => {
        clearTimeout(waiter.timer)
        this.inviteRequests.delete(id)
        rejectLink(error)
      },
    }
    this.inviteRequests.set(id, waiter)
    socket.send(encodeRelayControl(this.sendCipher, JSON.stringify(frame(id))))
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
    if (!this.options.config.relayKey) {
      throw new RelayError("RELAY_SUBJECT_INVALID", "relay subject has no pinned relay key; re-enroll this host")
    }
    this.options.onState?.("connecting")
    const socket = createSocket(this.options.config.url, this.options.caPath)
    socket.binaryType = "arraybuffer"
    this.socket = socket
    this.authenticated = false
    this.sendCipher = undefined
    this.receiveCipher = undefined
    this.caps.clear()

    await waitForOpen(socket, 10_000)
    if (this.socket !== socket || this.closed) {
      socket.close()
      throw new Error("relay connection was cancelled")
    }

    this.options.onState?.("authenticating")
    const result = await relayNoiseHandshake(
      socket,
      this.options.config.relayKey,
      {
        t: "relay.hello",
        v: 3,
        kind: "host",
        subjectId: this.options.config.subjectId,
        secret: this.options.config.secret,
      },
      10_000,
    )
    const welcome = result.welcome
    if (welcome.t === "relay.error") {
      throw new RelayError(
        stringValue(welcome.code) || "RELAY_BAD_REQUEST",
        stringValue(welcome.message) || "relay authentication failed",
      )
    }
    this.sendCipher = result.send
    this.receiveCipher = result.receive
    this.authenticated = true
    this.applyWelcome(welcome)

    socket.onmessage = (event) => this.handleIncoming(event.data)
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

  private applyWelcome(value: Record<string, unknown>): void {
    const room = stringValue(value.room)
    if (room && room !== this.options.config.room) {
      this.options.onState?.("authenticating", `relay room changed to ${room}`)
      this.options.config.room = room
    }
    if (Array.isArray(value.caps)) {
      this.caps.clear()
      for (const cap of value.caps) {
        if (typeof cap === "string") this.caps.add(cap)
      }
    }
  }

  private handleIncoming(data: unknown): void {
    this.handleMessage(data)
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      if (!this.receiveCipher) return
      const text = decodeRelayControl(this.receiveCipher, data)
      if (text) this.handleControl(text)
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
      const id = stringValue(value.id)
      if (link) this.resolveInvite(id, link)
      else this.rejectInvite(id, new RelayError("RELAY_BAD_REQUEST", "relay returned an empty phone invite"))
      return
    }
    if (value.t === "relay.pair") {
      const url = stringValue(value.url)
      const id = stringValue(value.id)
      if (url) this.resolveInvite(id, url)
      else this.rejectInvite(id, new RelayError("RELAY_BAD_REQUEST", "relay returned an empty pairing URL"))
      return
    }
    if (value.t === "relay.error" && this.inviteRequests.size > 0) {
      this.rejectInvite(
        stringValue(value.id),
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

  private resolveInvite(id: string | undefined, link: string): void {
    const waiter = id ? this.inviteRequests.get(id) : this.inviteRequests.values().next().value
    waiter?.resolve(link)
  }

  private rejectInvite(id: string | undefined, error: Error): void {
    if (id) {
      this.inviteRequests.get(id)?.reject(error)
      return
    }
    const waiter = this.inviteRequests.values().next().value
    waiter?.reject(error)
  }

  private rejectAllInvites(error: Error): void {
    for (const waiter of [...this.inviteRequests.values()]) waiter.reject(error)
    this.inviteRequests.clear()
  }

  private attach(clientId: number): void {
    if (this.sessions.has(clientId)) return
    const peer = new RelayPeer(this, clientId)
    const session = this.options.createSession(peer)
    this.sessions.set(clientId, { session, peer })
  }

  private handleDisconnect(reason: string): void {
    this.rejectAllInvites(new RelayError("RELAY_OFFLINE", reason))
    this.authenticated = false
    this.sendCipher = undefined
    this.receiveCipher = undefined
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
