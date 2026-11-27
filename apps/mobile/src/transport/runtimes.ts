import type { Transport } from "@ocremote/protocol"
import { deviceInfo } from "@/config/device"
import { useConnections, type HostConnection } from "@/stores/connections"
import { credentialsFor, useHosts } from "@/stores/hosts"
import { loadRelayAccess, normalizeRelayUrl } from "@/storage/relay"
import { HostEventStream, type OpencodeEvent } from "@/transport/hostEvents"
import {
  candidateUrls,
  HostError,
  HostRuntime,
  type ConnectionState,
  type HostSession,
  type OpencodeState,
  type RelayAuthResolver,
} from "@/transport/hostRuntime"

const runtimes = new Map<string, HostRuntime>()
const pending = new Map<string, Promise<HostRuntime>>()
const eventStreams = new Map<string, HostEventStream>()

export async function ensureConnection(hostId: string, options: { force?: boolean } = {}): Promise<HostRuntime> {
  if (options.force) closeRuntime(hostId)

  const existing = runtimes.get(hostId)
  if (existing?.state === "ready") return existing

  const pendingConnection = pending.get(hostId)
  if (pendingConnection) return pendingConnection
  // The existing runtime owns its reconnect backoff and event stream. Requests
  // during an outage must not replace it or discard the screen's subscribers.
  if (existing) throw existing.lastError ?? new HostError("network", "host is reconnecting")

  const promise = openConnection(hostId)
  pending.set(hostId, promise)
  try {
    return await promise
  } finally {
    pending.delete(hostId)
  }
}

export function getRuntime(hostId: string): HostRuntime | undefined {
  return runtimes.get(hostId)
}

/**
 * Opens a short-lived session over one saved transport and checks opencode.
 * It intentionally does not touch the active runtime so a user can test a
 * route that is not currently selected.
 */
export async function testTransport(
  hostId: string,
  transport: Transport,
  timeoutMs = 6_000,
): Promise<number> {
  const host = useHosts.getState().getHost(hostId)
  if (!host) throw new HostError("network", "主机不存在")
  const credentials = await credentialsFor(hostId)
  if (!credentials) throw new HostError("auth", "这台主机的设备令牌已丢失，请重新配对")
  const relayAuth = await relayAuthFor([transport])
  const runtime = new HostRuntime({
    hostId,
    hostPublicKey: host.publicKey,
    candidates: candidateUrls([transport]),
    deviceId: credentials.deviceId,
    token: credentials.token,
    device: deviceInfo,
    autoReconnect: false,
    ...(relayAuth ? { relayAuth } : {}),
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const started = Date.now()
    await Promise.race([
      runtime.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new HostError("timeout", "连接测试超时")),
          timeoutMs,
        )
      }),
    ])
    const response = await runtime.request({
      method: "GET",
      path: "/api/info",
      timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - started)),
    })
    if (response.status !== 200) {
      throw new HostError("http", `opencode returned HTTP ${response.status}`, {
        status: response.status,
      })
    }
    return Date.now() - started
  } finally {
    if (timer) clearTimeout(timer)
    runtime.disconnect()
  }
}

export function closeRuntime(hostId: string): void {
  eventStreams.get(hostId)?.stop()
  eventStreams.delete(hostId)
  const runtime = runtimes.get(hostId)
  if (!runtime) return
  runtime.disconnect()
  runtimes.delete(hostId)
  useConnections.getState().remove(hostId)
}

export function subscribeHostEvents(hostId: string, listener: (event: OpencodeEvent) => void): () => void {
  return ensureEventStream(hostId)?.subscribe(listener) ?? (() => undefined)
}

export function isConnected(hostId: string): boolean {
  return runtimes.get(hostId)?.state === "ready"
}

export async function refreshInfo(hostId: string): Promise<{ version?: string; hostname?: string }> {
  const runtime = await ensureConnection(hostId)
  const response = await runtime.request({ method: "GET", path: "/api/info", timeoutMs: 8_000 })
  if (response.status !== 200) throw new HostError("http", `opencode returned HTTP ${response.status}`, { status: response.status })
  const info = JSON.parse(response.body) as { version?: string; hostname?: string }
  const current = useConnections.getState().byHost[hostId]
  if (current?.session) {
    useConnections.getState().patch(hostId, {
      session: {
        ...current.session,
        opencode: { ...current.session.opencode, ...(info.version ? { version: info.version } : {}) },
      },
      lastSyncedAt: Date.now(),
      latencyMs: runtime.latencyMs,
    })
  }
  return info
}

async function openConnection(hostId: string): Promise<HostRuntime> {
  closeRuntime(hostId)
  const host = useHosts.getState().getHost(hostId)
  if (!host) throw new HostError("network", "主机不存在")
  const credentials = await credentialsFor(hostId)
  if (!credentials) throw new HostError("auth", "这台主机的设备令牌已丢失，请重新配对")
  const relayAuth = await relayAuthFor(host.transports)

  const runtime = new HostRuntime({
    hostId,
    hostPublicKey: host.publicKey,
    candidates: candidateUrls(host.transports),
    deviceId: credentials.deviceId,
    token: credentials.token,
    device: deviceInfo,
    autoReconnect: true,
    ...(relayAuth ? { relayAuth } : {}),
  })
  runtimes.set(hostId, runtime)

  runtime.onStateChange((state) => {
    const patch: Partial<HostConnection> = { status: state }
    if (state === "ready") {
      patch.latencyMs = runtime.latencyMs
      patch.lastSyncedAt = Date.now()
      patch.error = undefined
      if (runtime.session) patch.session = runtime.session
      patch.transport = transportKind(host.transports, runtime.activeCandidate)
    } else if (state === "error") {
      const failure = runtime.lastError
      if (failure) {
        patch.error = { kind: failure.kind, message: failure.message, ...(failure.code ? { code: failure.code } : {}) }
      }
    }
    useConnections.getState().patch(hostId, patch)
  })

  // The host pushes opencode availability; mirror it into the connection store
  // so the header can distinguish "host offline" from "opencode offline".
  runtime.subscribe((event) => {
    if (!isOpencodeStateEvent(event)) return
    const current = useConnections.getState().byHost[hostId]?.session
    if (!current) return
    const opencode = { ...current.opencode }
    opencode.available = event.state.available
    if (event.state.version) opencode.version = event.state.version
    if (event.state.baseUrl) opencode.baseUrl = event.state.baseUrl
    if (event.state.error) opencode.error = event.state.error
    else delete opencode.error
    useConnections.getState().patch(hostId, { session: { ...current, opencode } })
  })

  useConnections.getState().patch(hostId, { status: "connecting" })

  try {
    await runtime.connect()
  } catch (error) {
    const failure = error instanceof HostError ? error : new HostError("network", error instanceof Error ? error.message : "连接失败")
    if (failure.kind !== "network" && failure.kind !== "timeout") {
      runtimes.delete(hostId)
      runtime.disconnect()
    }
    useConnections.getState().patch(hostId, {
      status: "error",
      error: { kind: failure.kind, message: failure.message, ...(failure.code ? { code: failure.code } : {}) },
    })
    throw failure
  }

  await useHosts.getState().touchHost(hostId, transportKind(host.transports, runtime.activeCandidate))
  const session = runtime.session
  useConnections.getState().patch(hostId, {
    status: "ready",
    ...(session ? { session } : {}),
    lastSyncedAt: Date.now(),
    ...(runtime.latencyMs !== undefined ? { latencyMs: runtime.latencyMs } : {}),
  })
  return runtime
}

function ensureEventStream(hostId: string, runtime?: HostRuntime): HostEventStream | undefined {
  const active = runtime ?? runtimes.get(hostId)
  if (!active) return undefined
  const existing = eventStreams.get(hostId)
  if (existing) return existing
  const stream = new HostEventStream(active)
  eventStreams.set(hostId, stream)
  return stream
}

async function relayAuthFor(transports: Transport[]): Promise<RelayAuthResolver | undefined> {
  const entries = new Map<string, { subjectId: string; secret: string; relayKey: string }>()
  for (const transport of transports) {
    if (transport.kind !== "relay") continue
    const access = await loadRelayAccess(transport.url)
    if (access) {
      entries.set(normalizeRelayUrl(transport.url), {
        subjectId: access.subjectId,
        secret: access.secret,
        relayKey: access.relayKey,
      })
    }
  }
  if (entries.size === 0) return undefined
  return (url) => entries.get(normalizeRelayUrl(url))
}

function transportKind(transports: Transport[], activeCandidate: string | undefined): "lan" | "relay" | "custom" | undefined {
  if (!activeCandidate) return undefined
  const match = transports.find((transport) => {
    if (transport.kind === "relay") {
      try {
        const url = new URL(activeCandidate)
        return url.origin === new URL(transport.url).origin && url.pathname === new URL(transport.url).pathname
      } catch {
        return activeCandidate.startsWith(transport.url)
      }
    }
    return transport.url === activeCandidate
  })
  return match?.kind
}

function isOpencodeStateEvent(
  event: unknown,
): event is { type: "host.opencode"; state: OpencodeState } {
  if (typeof event !== "object" || event === null) return false
  const value = event as { type?: unknown; state?: unknown }
  return value.type === "host.opencode" && typeof value.state === "object" && value.state !== null
}

export type { ConnectionState, HostSession }
