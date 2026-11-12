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
import { registerRelayRoom, RelayHostClient } from "./relay.ts"
import { ConnectionSession, type HostContext } from "./session.ts"

export type HostOptions = {
  homeDir?: string
  hostname?: string
  port?: number
  name?: string
  opencodeUrl?: string
  opencodePassword?: string
  relay?: RelayConfig
  relaySecret?: string
}

export type Host = {
  server: Bun.Server<unknown>
  port: number
  identity: Identity
  config: HostConfig
  target: OpencodeTarget
  relay?: RelayConfig
  issuePairCode(scope?: DeviceScope): Promise<string>
  pairingOffer(code: string, transportUrl?: string): Promise<string>
  close(): Promise<void>
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
  const relayConfig = options.relay ?? config.relay
  if (relayConfig) config.relay = relayConfig
  const target = await resolveOpencodeTarget({
    ...(options.opencodeUrl ? { url: options.opencodeUrl } : {}),
    ...(options.opencodePassword ? { password: options.opencodePassword } : {}),
  })

  const ctx: HostContext = {
    identity,
    config,
    target,
    lanUrls: [],
    async saveConfig() {
      await saveConfig(home, config)
    },
  }

  let relayClient: RelayHostClient | undefined
  const sessions = new WeakMap<object, ConnectionSession>()
  let server: Bun.Server<unknown>
  server = Bun.serve<unknown>({
    hostname,
    port,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ ok: true, v: 1 })
      if (url.pathname !== "/ws") return new Response("not found", { status: 404 })
      if (server.upgrade(request, { data: {} })) return
      return new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      open(ws) {
        sessions.set(ws, new ConnectionSession(ws, ctx))
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
  ctx.lanUrls = lanUrls(hostname, actualPort)
  await saveConfig(home, config)

  if (relayConfig) {
    const relaySecret = options.relaySecret ?? process.env.RELAY_REGISTRATION_SECRET
    relayClient = new RelayHostClient({
      config: relayConfig,
      createSession: (socket) => new ConnectionSession(socket, ctx),
      onState: (state, detail) => {
        if (state === "reconnecting" || state === "closed") {
          console.warn(`[relay] ${state}${detail ? `: ${detail}` : ""}`)
        }
      },
      ...(relaySecret
        ? {
            onBeforeReconnect: async () => {
              await registerRelayRoom({
                relayUrl: relayConfig.url,
                secret: relaySecret,
                room: relayConfig.room,
                hostToken: relayConfig.hostToken,
                clientToken: relayConfig.clientToken,
              })
            },
          }
        : {}),
    })
    try {
      if (relaySecret) {
        await registerRelayRoom({
          relayUrl: relayConfig.url,
          secret: relaySecret,
          room: relayConfig.room,
          hostToken: relayConfig.hostToken,
          clientToken: relayConfig.clientToken,
        })
      }
      await relayClient.start()
    } catch (error) {
      relayClient.close()
      server.stop(true)
      throw error
    }
  }

  return {
    server,
    port: actualPort,
    identity,
    config,
    target,
    ...(relayConfig ? { relay: relayConfig } : {}),
    async issuePairCode(scope: DeviceScope = "full") {
      const { code } = addPendingPair(config, scope)
      await saveConfig(home, config)
      return code
    },
    async pairingOffer(code: string, transportUrl?: string) {
      const pending = config.pendingPairs.find((pair) => pair.codeHash === hashPairCode(code))
      if (!pending) throw new Error("pairing code not found")
      const transports: Transport[] = [
        {
          kind: "lan",
          url: transportUrl ?? ctx.lanUrls[0] ?? `ws://127.0.0.1:${actualPort}/ws`,
          priority: 0,
        },
      ]
      if (config.relay) {
        transports.push({
          kind: "relay",
          url: config.relay.url,
          room: config.relay.room,
          clientToken: config.relay.clientToken,
          priority: 1,
        })
      }
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
    async close() {
      relayClient?.close()
      await saveConfig(home, config)
      server.stop(true)
    },
  }
}

export function lanUrls(hostname: string, port: number): string[] {
  if (hostname !== "0.0.0.0" && hostname !== "::") return [`ws://${hostname}:${port}/ws`]
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => `ws://${entry.address}:${port}/ws`)
  return addresses.length > 0 ? addresses : [`ws://127.0.0.1:${port}/ws`]
}
