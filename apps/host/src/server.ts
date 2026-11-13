import { randomBytes } from "node:crypto"
import { networkInterfaces } from "node:os"
import {
  encodePairingOffer,
  fingerprintOfPublicKey,
  type PairingOffer,
  type Transport,
} from "@ocremote/protocol"
import {
  loadConfig,
  loadOrCreateIdentity,
  resolveHome,
  saveConfig,
  type DeviceScope,
  type HostConfig,
  type Identity,
  type RelayConfig,
} from "./config.ts"
import { addPendingPair, hashPairCode } from "./pairing.ts"
import { resolveOpencodeTarget, type OpencodeTarget } from "./opencode.ts"
import { HostModelManager } from "./asr/modelManager.ts"
import { HostAsr, type AsrService } from "./asr/service.ts"
import { RelayHostClient } from "./relay.ts"
import { ConnectionSession, type ClientInfo, type HostContext } from "./session.ts"

export type HostOptions = {
  homeDir?: string
  hostname?: string
  port?: number
  name?: string
  opencodeUrl?: string
  opencodePassword?: string
  /** Relay is used only when this is set; a saved room is never activated implicitly. */
  relay?: RelayConfig
  /** PEM CA used to verify the relay TLS certificate (development / private CA). */
  relayCa?: string
  modelsDir?: string
  modelBaseUrl?: string
  asrModelId?: string
  asr?: AsrService
}

export type Host = {
  server: Bun.Server<unknown>
  port: number
  hostname: string
  identity: Identity
  config: HostConfig
  target: OpencodeTarget
  relay?: RelayConfig
  lanUrls: string[]
  modelsDir: string
  asr: AsrService
  clients(): ClientInfo[]
  issuePairCode(scope?: DeviceScope, ttlMs?: number): Promise<string>
  pairingOffer(code: string, transportUrl?: string): Promise<string>
  /** Stores the offer on the local HTTP server and returns a short QR URL. */
  shortenOffer(offer: string, baseUrl?: string): string
  close(): Promise<void>
}

type PairPage = {
  offer: string
  expiresAt: number
}

export async function startHost(options: HostOptions = {}): Promise<Host> {
  const home = resolveHome(options.homeDir)
  const identity = await loadOrCreateIdentity(home, options.name)
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? 8787
  const config = await loadConfig(home, {
    hostId: identity.hostId,
    name: options.name ?? process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
    lan: { hostname, port },
  })
  // Only an explicitly requested relay is activated. This prevents a stale
  // room from a previous run from taking over a direct/LAN-only start.
  const relayConfig = options.relay
  if (relayConfig) config.relay = relayConfig
  const target = await resolveOpencodeTarget({
    ...(options.opencodeUrl ? { url: options.opencodeUrl } : {}),
    ...(options.opencodePassword ? { password: options.opencodePassword } : {}),
  })

  const modelManager = new HostModelManager({
    ...(options.modelsDir ? { modelsDir: options.modelsDir } : {}),
    ...(options.modelBaseUrl ? { baseUrl: options.modelBaseUrl } : {}),
  })
  const asr = options.asr ?? new HostAsr(modelManager, options.asrModelId)

  const clientRegistry = new Map<number, ClientInfo>()
  let nextClientId = 1
  let server: Bun.Server<unknown>

  const ctx: HostContext = {
    identity,
    config,
    target,
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

  const pairPages = new Map<string, PairPage>()

  let relayClient: RelayHostClient | undefined
  const sessions = new WeakMap<object, ConnectionSession>()

  server = Bun.serve<unknown>({
    hostname,
    port,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ ok: true, v: 1, version: "0.1.0" })
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
      if (server.upgrade(request, { data: {} })) return
      return new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      open(ws) {
        const session = new ConnectionSession(ws, ctx, {
          transport: "direct",
          ...(ws.remoteAddress ? { remoteAddress: ws.remoteAddress } : {}),
        })
        sessions.set(ws, session)
      },
      message(ws, message) {
        const session = sessions.get(ws)
        if (!session) return
        if (typeof message === "string") session.onText(message)
        else session.onBinary(new Uint8Array(message))
      },
      close(ws) {
        sessions.get(ws)?.close()
        sessions.delete(ws)
      },
    },
  })

  const actualPort = server.port ?? port
  config.lan = { hostname, port: actualPort }
  const urls = lanUrls(hostname, actualPort)
  ctx.lanUrls = urls
  await saveConfig(home, config)

  if (relayConfig) {
    relayClient = new RelayHostClient({
      config: relayConfig,
      ...(options.relayCa ? { caPath: options.relayCa } : {}),
      createSession: (socket) => new ConnectionSession(socket, ctx, { transport: "relay" }),
      onState: (state, detail) => {
        if (state === "reconnecting" || state === "closed") {
          console.warn(`[relay] ${state}${detail ? `: ${detail}` : ""}`)
        }
      },
      onClientInvite: (link) => {
        // Keep the last phone link on disk so "ocremote pair --relay" can still
        // build an offer while the host is stopped.
        relayConfig.clientInvite = link
        void saveConfig(home, config).catch(() => undefined)
      },
    })
    try {
      await relayClient.start()
    } catch (error) {
      relayClient.close()
      server.stop(true)
      throw error
    }
  }

  const host: Host = {
    server,
    port: actualPort,
    hostname,
    identity,
    config,
    target,
    ...(relayConfig ? { relay: relayConfig } : {}),
    lanUrls: urls,
    modelsDir: modelManager.modelsDir,
    asr,
    clients() {
      return [...clientRegistry.values()].sort((left, right) => (left.connectedAt ?? 0) - (right.connectedAt ?? 0))
    },
    async issuePairCode(scope: DeviceScope = "full", ttlMs?: number) {
      const { code } = addPendingPair(config, scope, ttlMs)
      await saveConfig(home, config)
      return code
    },
    async pairingOffer(code: string, transportUrl?: string) {
      const pending = config.pendingPairs.find((pair) => pair.codeHash === hashPairCode(code))
      if (!pending) throw new Error("pairing code not found")
      const transports: Transport[] = []
      const directUrl = transportUrl ?? urls[0]
      if (directUrl) {
        transports.push({ kind: "lan", url: directUrl, priority: 0 })
      }
      if (relayConfig) {
        let clientInvite = relayConfig.clientInvite
        if (relayClient) {
          // The host is connected to the relay, so ask it for a fresh phone
          // link for this pairing code. Fall back to the cached link when the
          // relay is temporarily unreachable.
          try {
            clientInvite = await relayClient.requestClientInvite()
          } catch {
            // keep the cached invite
          }
        }
        transports.push({
          kind: "relay",
          url: relayConfig.url,
          room: relayConfig.room,
          priority: transports.length,
          ...(clientInvite ? { invite: clientInvite } : {}),
        })
      }
      if (transports.length === 0) throw new Error("no transport is available for pairing")
      const offer: PairingOffer = {
        v: 1,
        hostId: identity.hostId,
        name: config.name,
        pk: "",
        fingerprint: fingerprintOfPublicKey(identity.publicKey),
        pairCode: code,
        expiresAt: pending.expiresAt,
        transports,
      }
      return encodePairingOffer(offer, identity.publicKey)
    },
    shortenOffer(offer, baseUrl) {
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
      const base = baseUrl ?? httpOrigin(urls[0] ?? `ws://127.0.0.1:${actualPort}/ws`)
      return `${base}/p/${id}`
    },
    async close() {
      asr.close()
      relayClient?.close()
      await saveConfig(home, config)
      server.stop(true)
    },
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
