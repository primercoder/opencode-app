import type { Transport } from "@ocremote/protocol"
import { deviceInfo } from "@/config/device"
import { useConnections, type HostConnection } from "@/stores/connections"
import { credentialsFor, useHosts } from "@/stores/hosts"
import { HostEventStream, type OpencodeEvent } from "@/transport/hostEvents"
import {
  candidateUrls,
  HostError,
  HostRuntime,
  type ConnectionState,
  type HostSession,
} from "@/transport/hostRuntime"

const runtimes = new Map<string, HostRuntime>()
const pending = new Map<string, Promise<HostRuntime>>()
const eventStreams = new Map<string, HostEventStream>()

export async function ensureConnection(hostId: string, options: { force?: boolean } = {}): Promise<HostRuntime> {
  if (options.force) closeRuntime(hostId)

  const existing = runtimes.get(hostId)
  if (existing?.state === "ready") {
    ensureEventStream(hostId, existing)
    return existing
  }

  const pendingConnection = pending.get(hostId)
  if (pendingConnection) return pendingConnection

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

  const runtime = new HostRuntime({
    hostId,
    hostPublicKey: host.publicKey,
    candidates: candidateUrls(host.transports),
    deviceId: credentials.deviceId,
    token: credentials.token,
    device: deviceInfo,
    autoReconnect: true,
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

  useConnections.getState().patch(hostId, { status: "connecting" })

  try {
    await runtime.connect()
  } catch (error) {
    runtimes.delete(hostId)
    runtime.disconnect()
    const failure = error instanceof HostError ? error : new HostError("network", error instanceof Error ? error.message : "连接失败")
    useConnections.getState().patch(hostId, {
      status: "error",
      error: { kind: failure.kind, message: failure.message, ...(failure.code ? { code: failure.code } : {}) },
    })
    throw failure
  }

  ensureEventStream(hostId, runtime)
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
  stream.start()
  eventStreams.set(hostId, stream)
  return stream
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

export type { ConnectionState, HostSession }
