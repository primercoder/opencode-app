import { randomBytes } from "node:crypto"
import { networkInterfaces } from "node:os"
import {
  encodePairingOffer,
  fingerprintOfPublicKey,
  type PairingOffer,
  type Transport,
} from "@ocremote/protocol"
import {
  isLoopbackHostname,
  loadConfig,
  loadOrCreateIdentity,
  resolveHome,
  saveConfig,
  type DeviceScope,
  type DirectConfig,
  type HostConfig,
  type Identity,
  type RelayConfig,
} from "./config.ts"
import { addPendingPair, hashPairCode } from "./pairing.ts"
import { OpencodeMonitor, type OpencodeState } from "./opencode.ts"
import { browseRoot } from "./pathService.ts"
import { HostModelManager } from "./asr/modelManager.ts"
import { HostAsr, type AsrService } from "./asr/service.ts"
import { RelayHostClient, type RelayState } from "./relay.ts"
import { ConnectionSession, type ClientInfo, type HostContext } from "./session.ts"
import { HOST_VERSION } from "./daemon.ts"

export type HostOptions = {
  homeDir?: string
  /** Legacy direct binding. Prefer `direct`. */
  hostname?: string
  port?: number
  /** Initial direct binding. null disables direct. undefined uses saved config. */
  direct?: DirectConfig | null
  name?: string
  opencodeUrl?: string
  opencodePassword?: string
  /** Initial relay. null disables relay. undefined uses saved config. */
  relay?: RelayConfig | null
  /** PEM CA used to verify an optional TLS relay certificate. */
  relayCa?: string
  modelsDir?: string
  modelBaseUrl?: string
  asrModelId?: string
  asr?: AsrService
  /** How often to re-probe opencode while it is unreachable. */
  opencodeProbeMs?: number
  /** Root directory phones may browse when creating sessions. */
  browseRoot?: string
}

export type DirectStatus = {
  hostname: string
  port: number
  urls: string[]
}

export type RelayStatus = {
  url: string
  room: string
  state: RelayState
}

export type PairRoute = {
  kind: "direct" | "relay"
  offer: string
  url: string
  room?: string
  shortUrl?: string
  hasInvite?: boolean
  expiresAt: number
}

export type Host = {
  identity: Identity
  config: HostConfig
  modelsDir: string
  asr: AsrService
  /** Live opencode registration/probe state; the host runs without opencode. */
  opencode(): OpencodeState
  onOpencodeChange(listener: (state: OpencodeState) => void): () => void
  /** Re-probes opencode immediately (used by status and diagnostics). */
  refreshOpencode(): Promise<OpencodeState>
  /** Current local direct listener, or undefined when direct is off. */
  direct(): DirectStatus | undefined
  relay(): RelayStatus | undefined
  clients(): ClientInfo[]
  issuePairCode(scope?: DeviceScope, ttlMs?: number): Promise<string>
  /** One labeled offer per enabled route, each with its own one-time code. */
  pairingRoutes(input?: { scope?: DeviceScope; ttlMs?: number; directUrl?: string }): Promise<PairRoute[]>
  setDirect(direct: DirectConfig | null): Promise<DirectStatus | undefined>
  setRelay(relay: RelayConfig | null, caPath?: string): Promise<void>
  /** Stores the offer on the local HTTP server and returns a short QR URL. */
  shortenOffer(offer: string, baseUrl?: string): string | undefined
  close(): Promise<void>
}

type PairPage = {
  offer: string
  expiresAt: number
}

export async function startHost(options: HostOptions = {}): Promise<Host> {
  const home = resolveHome(options.homeDir)
  const identity = await loadOrCreateIdentity(home, options.name)
  const config = await loadConfig(home, {
    hostId: identity.hostId,
    name: options.name ?? process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
  })
  // The host must come up even when opencode is not running. The monitor keeps
  // probing and reports availability to paired phones.
  const monitor = new OpencodeMonitor({
    ...(options.opencodeUrl ? { url: options.opencodeUrl } : {}),
    ...(options.opencodePassword ? { password: options.opencodePassword } : {}),
    ...(options.opencodeProbeMs ? { intervalMs: options.opencodeProbeMs } : {}),
  })
  await monitor.start()

  const modelManager = new HostModelManager({
    ...(options.modelsDir ? { modelsDir: options.modelsDir } : {}),
    ...(options.modelBaseUrl ? { baseUrl: options.modelBaseUrl } : {}),
  })
  const asr = options.asr ?? new HostAsr(modelManager, options.asrModelId)

  const clientRegistry = new Map<number, ClientInfo>()
  let nextClientId = 1
  let directServer: Bun.Server<unknown> | undefined
  let directStatus: DirectStatus | undefined
  let relayConfig: RelayConfig | null = null
  let relayClient: RelayHostClient | undefined
  let relayState: RelayState | undefined
  let closed = false

  const pairPages = new Map<string, PairPage>()
  const sessions = new WeakMap<object, ConnectionSession>()
  // Every authenticated session, so opencode availability changes can be
  // pushed to phones without waiting for their next poll.
  const liveSessions = new Set<ConnectionSession>()

  const ctx: HostContext = {
    identity,
    config,
    opencode: () => monitor.state,
    browseRoot: options.browseRoot ?? browseRoot(),
    asr,
    lanUrls: [],
    clients: {
      register(info) {
        const id = nextClientId++
        clientRegistry.set(id, { ...info, id, connectedAt: Date.now(), lastSeenAt: Date.now() })
        return id
      },
      touch(id) {
        const current = clientRegistry.get(id)
        if (current) current.lastSeenAt = Date.now()
      },
      unregister(id) {
        clientRegistry.delete(id)
      },
    },
    async saveConfig() {
      await saveConfig(home, config)
    },
  }

  const persist = async (): Promise<void> => saveConfig(home, config)

  // Push opencode availability so the phone can show "host online, opencode
  // offline" without polling. Phones that connect later get it in `welcome`.
  monitor.onChange((state) => {
    for (const session of liveSessions) {
      if (session.isClosed) {
        liveSessions.delete(session)
        continue
      }
      session.push({
        t: "opencode.state",
        state: {
          available: state.available,
          version: state.target?.version ?? "unknown",
          ...(state.target ? { baseUrl: state.target.url } : {}),
          ...(state.error ? { error: state.error } : {}),
        },
      })
    }
  })

  const stopDirect = async (): Promise<void> => {
    const server = directServer
    directServer = undefined
    directStatus = undefined
    ctx.lanUrls = []
    pairPages.clear()
    if (server) await server.stop(true)
  }

  const startDirect = async (direct: DirectConfig): Promise<DirectStatus> => {
    if (directStatus && directStatus.hostname === direct.hostname && directStatus.port === direct.port) {
      return directStatus
    }
    await stopDirect()
    const server = Bun.serve<unknown>({
      hostname: direct.hostname,
      port: direct.port,
      fetch(request, current) {
        const url = new URL(request.url)
        if (url.pathname === "/health") return Response.json({ ok: true, v: 2, version: HOST_VERSION })
        if (url.pathname.startsWith("/p/")) {
          const id = url.pathname.slice("/p/".length)
          const page = pairPages.get(id)
          if (!page) return new Response("pairing offer not found", { status: 404 })
          if (page.expiresAt <= Date.now()) {
            pairPages.delete(id)
            return new Response("pairing offer expired", { status: 410 })
          }
          return new Response(page.offer, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            },
          })
        }
        if (url.pathname !== "/ws") return new Response("not found", { status: 404 })
        if (current.upgrade(request, { data: {} })) return
        return new Response("WebSocket upgrade required", { status: 426 })
      },
      websocket: {
        open(ws) {
          const session = new ConnectionSession(ws, ctx, {
            transport: "direct",
            ...(ws.remoteAddress ? { remoteAddress: ws.remoteAddress } : {}),
          })
          sessions.set(ws, session)
          liveSessions.add(session)
        },
        message(ws, message) {
          const session = sessions.get(ws)
          if (!session) return
          if (typeof message === "string") session.onText(message)
          else session.onBinary(new Uint8Array(message))
        },
        close(ws) {
          const session = sessions.get(ws)
          session?.close()
          if (session) liveSessions.delete(session)
          sessions.delete(ws)
        },
      },
    })
    const actualPort = server.port ?? direct.port
    directServer = server
    directStatus = {
      hostname: direct.hostname,
      port: actualPort,
      urls: lanUrls(direct.hostname, actualPort),
    }
    config.direct = { hostname: direct.hostname, port: actualPort }
    ctx.lanUrls = directStatus.urls
    await persist()
    return directStatus
  }

  const stopRelay = (): void => {
    relayClient?.close()
    relayClient = undefined
    relayState = undefined
    if (relayConfig) relayConfig.enabled = false
    if (config.relay) config.relay.enabled = false
    relayConfig = null
  }

  const startRelay = async (next: RelayConfig, caPath?: string): Promise<void> => {
    if (!next.relayKey) {
      throw new Error("relay subject has no pinned relay key; re-enroll this host")
    }
    const previous = relayClient
    const previousConfig = relayConfig
    const previousCa = options.relayCa
    previous?.close()
    relayClient = undefined
    relayState = "connecting"
    next.enabled = true
    relayConfig = next
    config.relay = next
    const client = new RelayHostClient({
      config: next,
      ...(caPath ?? previousCa ? { caPath: caPath ?? previousCa } : {}),
      createSession: (socket) => {
        const session = new ConnectionSession(socket, ctx, { transport: "relay" })
        liveSessions.add(session)
        return session
      },
      onState: (state, detail) => {
        relayState = state
        for (const session of liveSessions) {
          if (session.isClosed) liveSessions.delete(session)
        }
        if (state === "reconnecting" || state === "closed") {
          console.warn(`[relay] ${state}${detail ? `: ${detail}` : ""}`)
        }
      },
    })
    relayClient = client
    try {
      await client.start()
      relayState = "open"
      await persist()
    } catch (error) {
      client.close()
      relayClient = undefined
      relayState = undefined
      relayConfig = previousConfig
      if (previousConfig) {
        previousConfig.enabled = true
        config.relay = previousConfig
        if (previous) {
          const restored = new RelayHostClient({
            config: previousConfig,
            ...(caPath ?? previousCa ? { caPath: caPath ?? previousCa } : {}),
            createSession: (socket) => new ConnectionSession(socket, ctx, { transport: "relay" }),
            onState: (state) => {
              relayState = state
            },
          })
          relayClient = restored
          try {
            await restored.start()
            relayState = "open"
          } catch {
            restored.close()
            relayClient = undefined
            relayState = undefined
          }
        }
      } else {
        delete config.relay
      }
      await persist().catch(() => undefined)
      throw error
    }
  }

  const phoneDirectUrl = (override?: string): string | undefined => {    if (override) return override
    if (!directStatus) return undefined
    if (isLoopbackHostname(directStatus.hostname)) return undefined
    const candidate = directPairUrl(directStatus.hostname, directStatus.port)
    return isLoopbackUrl(candidate) ? undefined : candidate
  }

  const relayInvite = async (): Promise<string> => {
    if (!relayConfig) throw new Error("relay is not enabled")
    if (!relayClient) throw new Error("relay is enabled but not connected; cannot create a phone invite")
    return relayClient.requestClientInvite()
  }

  const buildOffer = (
    code: string,
    expiresAt: number,
    transports: Transport[],
  ): string => {
    const offer: PairingOffer = {
      v: 1,
      hostId: identity.hostId,
      name: config.name,
      pk: "",
      fingerprint: fingerprintOfPublicKey(identity.publicKey),
      pairCode: code,
      expiresAt,
      transports,
    }
    return encodePairingOffer(offer, identity.publicKey)
  }

  const host: Host = {
    identity,
    config,
    modelsDir: modelManager.modelsDir,
    asr,
    opencode() {
      return monitor.state
    },
    onOpencodeChange(listener) {
      return monitor.onChange(listener)
    },
    async refreshOpencode() {
      return monitor.refresh()
    },
    direct() {
      return directStatus ? { ...directStatus, urls: [...directStatus.urls] } : undefined
    },
    relay() {
      return relayConfig
        ? { url: relayConfig.url, room: relayConfig.room, state: relayState ?? "closed" }
        : undefined
    },
    clients() {
      return [...clientRegistry.values()].sort((left, right) => (left.connectedAt ?? 0) - (right.connectedAt ?? 0))
    },
    async issuePairCode(scope: DeviceScope = "full", ttlMs?: number) {
      const { code } = addPendingPair(config, scope, ttlMs)
      await persist()
      return code
    },
    async pairingRoutes(input = {}) {
      const scope = input.scope ?? "full"
      const ttlMs = input.ttlMs
      const routes: PairRoute[] = []
      const directUrl = phoneDirectUrl(input.directUrl)
      if (directUrl) {
        const { code, pending } = addPendingPair(config, scope, ttlMs)
        routes.push({
          kind: "direct",
          offer: buildOffer(code, pending.expiresAt, [{ kind: "lan", url: directUrl, priority: 0 }]),
          url: directUrl,
          expiresAt: pending.expiresAt,
        })
      }
      if (relayConfig) {
        // The phone invite is pair-specific: request it only now, never at
        // connect time, and never fall back to a stale cached invite.
        const invite = await relayInvite()
        const { code, pending } = addPendingPair(config, scope, ttlMs)
        const offer = buildOffer(code, pending.expiresAt, [
          {
            kind: "relay",
            url: relayConfig.url,
            room: relayConfig.room,
            relayKey: relayConfig.relayKey,
            priority: 0,
            invite,
          },
        ])
        // A relay-only offer embeds the whole enrollment link (~300 chars), so
        // the QR would grow past 100 modules and wrap in an 80-column terminal.
        // Publish it on the relay and carry a short URL instead. Older relays
        // without the capability fall back to the full offer.
        const shortUrl = await relayClient?.publishPairOffer(offer).catch(() => undefined)
        routes.push({
          kind: "relay",
          offer,
          url: relayConfig.url,
          room: relayConfig.room,
          hasInvite: true,
          expiresAt: pending.expiresAt,
          ...(shortUrl ? { shortUrl } : {}),
        })
      }
      if (routes.length === 0) throw new Error("no phone-reachable transport is enabled")
      await persist()
      return routes
    },
    async setDirect(next) {
      if (!next) {
        await stopDirect()
        delete config.direct
        await persist()
        return undefined
      }
      return startDirect(next)
    },
    async setRelay(next, caPath) {
      if (!next) {
        stopRelay()
        await persist()
        return
      }
      await startRelay(next, caPath)
    },
    shortenOffer(offer, baseUrl) {
      if (!directStatus) return undefined
      const base = baseUrl ?? httpOrigin(directStatus.urls[0] ?? `ws://127.0.0.1:${directStatus.port}/ws`)
      const now = Date.now()
      for (const [key, page] of pairPages) {
        if (page.expiresAt <= now) pairPages.delete(key)
      }
      while (pairPages.size >= 32) {
        const oldest = pairPages.keys().next().value
        if (oldest === undefined) break
        pairPages.delete(oldest)
      }
      const id = randomBytes(9).toString("base64url")
      pairPages.set(id, { offer, expiresAt: now + 10 * 60_000 })
      return `${base}/p/${id}`
    },
    async close() {
      if (closed) return
      closed = true
      monitor.close()
      asr.close()
      relayClient?.close()
      relayClient = undefined
      await saveConfig(home, config)
      await stopDirect()
    },
  }

  const initialDirect =
    options.direct !== undefined
      ? options.direct
      : options.hostname
        ? { hostname: options.hostname, port: options.port ?? 8787 }
        : config.direct
  if (initialDirect) {
    try {
      await startDirect(initialDirect)
    } catch (error) {
      asr.close()
      throw error
    }
  }

  const initialRelay =
    options.relay !== undefined
      ? options.relay
      : config.relay && config.relay.enabled !== false
        ? config.relay
        : undefined
  if (initialRelay) {
    try {
      await startRelay(initialRelay, options.relayCa)
    } catch (error) {
      await host.close()
      throw error
    }
  }

  return host
}

export function lanUrls(hostname: string, port: number): string[] {
  if (hostname !== "0.0.0.0" && hostname !== "::") return [`ws://${hostname}:${port}/ws`]
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => `ws://${entry.address}:${port}/ws`)
  return addresses.length > 0 ? addresses : [`ws://127.0.0.1:${port}/ws`]
}

export function httpOrigin(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = ""
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/u, "")
}

/** Picks the most useful direct URL to show in a pairing offer. */
export function directPairUrl(hostname: string, port: number): string {
  if (hostname === "0.0.0.0" || hostname === "::") {
    const urls = lanUrls(hostname, port)
    return urls.find((url) => !url.includes("127.0.0.1")) ?? urls[0] ?? `ws://127.0.0.1:${port}/ws`
  }
  return `ws://${hostname}:${port}/ws`
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname)
  } catch {
    return true
  }
}
