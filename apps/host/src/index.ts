#!/usr/bin/env bun
import { Command } from "commander"
import qrcode from "qrcode-terminal"
import { encodePairingOffer, fingerprintOfPublicKey, type PairingOffer } from "@ocremote/protocol"
import {
  loadConfig,
  loadOrCreateIdentity,
  resolveHome,
  saveConfig,
  type DeviceScope,
  type HostConfig,
  type Identity,
} from "./config.ts"
import { addPendingPair, revokeDevice } from "./pairing.ts"
import { resolveOpencodeTarget } from "./opencode.ts"
import { lanUrls, startHost } from "./server.ts"

const program = new Command()
  .name("ocremote")
  .description("Encrypted remote access for a local opencode server")
  .version("0.0.1")

program
  .command("start")
  .description("Start the LAN WebSocket host")
  .option("--lan", "listen on all LAN interfaces", false)
  .option("--port <port>", "listen port", (value) => Number(value), 8787)
  .option("--name <name>", "host display name")
  .option("--opencode-url <url>", "opencode server URL")
  .option("--opencode-password <password>", "opencode server password")
  .option("--pair", "print a pairing QR after startup", false)
  .option("--read-only", "issue a read-only pairing code", false)
  .action(async (options: {
    lan: boolean
    port: number
    name?: string
    opencodeUrl?: string
    opencodePassword?: string
    pair: boolean
    readOnly: boolean
  }) => {
    const hostname = options.lan ? "0.0.0.0" : "127.0.0.1"
    const host = await startHost({
      hostname,
      port: options.port,
      ...(options.name ? { name: options.name } : {}),
      ...(options.opencodeUrl ? { opencodeUrl: options.opencodeUrl } : {}),
      ...(options.opencodePassword ? { opencodePassword: options.opencodePassword } : {}),
    })
    console.log(`ocremote host listening on ws://${hostname}:${host.port}/ws`)
    console.log(`opencode ${host.target.url} (${host.target.version ?? "unknown"}) · ${new Date().toISOString()}`)
    for (const url of lanUrls(hostname, host.port)) console.log(`  LAN candidate: ${url}`)
    if (options.pair) {
      const code = await host.issuePairCode(options.readOnly ? "read" : "full")
      printOffer(await host.pairingOffer(code))
    }
    process.on("SIGINT", () => {
      void host.close().finally(() => process.exit(0))
    })
  })

program
  .command("pair")
  .description("Issue a one-time pairing code and print its QR")
  .option("--lan", "use a LAN address instead of loopback", false)
  .option("--port <port>", "listen port", (value) => Number(value), 8787)
  .option("--url <url>", "override the LAN WebSocket URL")
  .option("--read-only", "create a read-only device code", false)
  .option("--ttl <minutes>", "pairing code lifetime in minutes", (value) => Number(value), 5)
  .action(async (options: { lan: boolean; port: number; url?: string; readOnly: boolean; ttl: number }) => {
    const home = resolveHome()
    const identity = await loadOrCreateIdentity(home)
    const hostname = options.lan ? "0.0.0.0" : "127.0.0.1"
    const config = await loadConfig(home, {
      hostId: identity.hostId,
      name: process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
      lan: { hostname, port: options.port },
    })
    const offer = await createOffer({
      config,
      identity,
      hostname,
      port: options.port,
      scope: options.readOnly ? "read" : "full",
      ttlMs: Math.max(1, options.ttl) * 60_000,
      ...(options.url ? { url: options.url } : {}),
    })
    await saveConfig(home, config)
    printOffer(offer)
    console.log("\nStart the host with: ocremote start --lan")
  })

const devices = program.command("devices").description("Manage paired devices")
devices
  .command("list")
  .description("List devices")
  .action(async () => {
    const { config } = await loadLocal()
    if (config.devices.length === 0) console.log("no paired devices")
    for (const device of config.devices) {
      console.log(
        `${device.id}  ${device.name}  ${device.scope}  ${device.revokedAt ? "revoked" : "active"}  lastSeen=${device.lastSeenAt ?? "-"}`,
      )
    }
  })
devices
  .command("revoke <id>")
  .description("Revoke a device")
  .action(async (id: string) => {
    const { home, config } = await loadLocal()
    if (!revokeDevice(config, id)) throw new Error(`device not found or already revoked: ${id}`)
    await saveConfig(home, config)
    console.log(`revoked ${id}`)
  })

program
  .command("doctor")
  .description("Check config, identity and opencode connectivity")
  .action(async () => {
    const home = resolveHome()
    const identity = await loadOrCreateIdentity(home)
    const target = await resolveOpencodeTarget()
    console.log(`host id: ${identity.hostId}`)
    console.log(`fingerprint: ${fingerprintOfPublicKey(identity.publicKey)}`)
    console.log(`opencode: ${target.url} (${target.version ?? "unknown"})`)
    console.log(`config: ${home}`)
  })

if (import.meta.main) {
  program.parseAsync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

async function loadLocal(): Promise<{ home: string; config: HostConfig }> {
  const home = resolveHome()
  const identity = await loadOrCreateIdentity(home)
  const config = await loadConfig(home, {
    hostId: identity.hostId,
    name: process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
    lan: { hostname: "0.0.0.0", port: 8787 },
  })
  return { home, config }
}

async function createOffer(input: {
  config: HostConfig
  identity: Identity
  hostname: string
  port: number
  scope: DeviceScope
  ttlMs: number
  url?: string
}): Promise<string> {
  const { code, pending } = addPendingPair(input.config, input.scope, input.ttlMs)
  const offer: PairingOffer = {
    v: 1,
    hostId: input.identity.hostId,
    name: input.config.name,
    pk: "",
    fingerprint: fingerprintOfPublicKey(input.identity.publicKey),
    pairCode: code,
    expiresAt: pending.expiresAt,
    transports: [
      {
        kind: "lan",
        url: input.url ?? lanUrls(input.hostname, input.port)[0] ?? `ws://127.0.0.1:${input.port}/ws`,
        priority: 0,
      },
    ],
  }
  return encodePairingOffer(offer, input.identity.publicKey)
}

function printOffer(url: string): void {
  qrcode.generate(url, { small: true }, (output) => console.log(output))
  console.log(`\nPairing link:\n${url}\n`)
}
