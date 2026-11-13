#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import { Command } from "commander"
import qrcode from "qrcode-terminal"
import { encodePairingOffer, fingerprintOfPublicKey, type PairingOffer } from "@ocremote/protocol"
import { formatModelSize } from "@ocremote/models"
import {
  loadConfig,
  loadOrCreateIdentity,
  resolveHome,
  saveConfig,
  type DeviceScope,
  type HostConfig,
  type Identity,
} from "./config.ts"
import { HostModelManager } from "./asr/modelManager.ts"
import { HostAsr } from "./asr/service.ts"
import { addPendingPair, revokeDevice } from "./pairing.ts"
import { registerRelayRoom } from "./relay.ts"
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
  .option("--pair-url <url>", "override the LAN URL printed in the pairing offer")
  .option("--read-only", "issue a read-only pairing code", false)
  .option("--relay-url <url>", "relay WebSocket URL, e.g. ws://127.0.0.1:26379/ws")
  .option("--relay-secret <secret>", "relay registration secret")
  .option("--relay-room <room>", "reuse a specific relay room")
  .option("--relay-new-room", "register a new relay room even if one is configured", false)
  .option("--models-dir <dir>", "local speech model directory")
  .option("--model-server <url>", "development model server base URL")
  .option("--asr-model <id>", "default host speech model id")
  .action(async (options: {
    lan: boolean
    port: number
    name?: string
    opencodeUrl?: string
    opencodePassword?: string
    pair: boolean
    pairUrl?: string
    readOnly: boolean
    relayUrl?: string
    relaySecret?: string
    relayRoom?: string
    relayNewRoom: boolean
    modelsDir?: string
    modelServer?: string
    asrModel?: string
  }) => {
    const hostname = options.lan ? "0.0.0.0" : "127.0.0.1"
    const relay = await resolveRelay({
      ...(options.relayUrl ? { url: options.relayUrl } : {}),
      ...(options.relaySecret ? { secret: options.relaySecret } : {}),
      ...(options.relayRoom ? { room: options.relayRoom } : {}),
      newRoom: options.relayNewRoom,
    })
    const host = await startHost({
      hostname,
      port: options.port,
      ...(options.name ? { name: options.name } : {}),
      ...(options.opencodeUrl ? { opencodeUrl: options.opencodeUrl } : {}),
      ...(options.opencodePassword ? { opencodePassword: options.opencodePassword } : {}),
      ...(relay ? { relay } : {}),
      ...(options.modelsDir ? { modelsDir: options.modelsDir } : {}),
      ...(options.modelServer ? { modelBaseUrl: options.modelServer } : {}),
      ...(options.asrModel ? { asrModelId: options.asrModel } : {}),
    })
    console.log(`ocremote host listening on ws://${hostname}:${host.port}/ws`)
    console.log(`opencode ${host.target.url} (${host.target.version ?? "unknown"}) · ${new Date().toISOString()}`)
    for (const url of lanUrls(hostname, host.port)) console.log(`  LAN candidate: ${url}`)
    const asr = (await host.asr.capabilities()) as { available?: boolean; models?: Array<{ id: string }> }
    console.log(`  ASR: ${asr.available ? asr.models?.map((model) => model.id).join(", ") : "unavailable (run `ocremote asr install <id>`)"}`)
    if (options.pair) {
      const code = await host.issuePairCode(options.readOnly ? "read" : "full")
      printOffer(await host.pairingOffer(code, options.pairUrl))
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

const asrCommand = program.command("asr").description("Manage local host speech models")

asrCommand
  .command("list")
  .description("List available host speech models")
  .option("--models-dir <dir>", "local speech model directory")
  .option("--model-server <url>", "development model server base URL")
  .action(async (options: { modelsDir?: string; modelServer?: string }) => {
    const manager = modelManager(options)
    const models = await manager.list()
    console.log(`models: ${manager.modelsDir}`)
    for (const model of models) {
      console.log(
        `${model.installed ? "installed" : "missing  "}  ${model.spec.id}  ${model.spec.label}  ${formatModelSize(model.spec.sizeBytes)}  [${model.spec.languages.join(", ")}]`,
      )
    }
  })

asrCommand
  .command("install <id>")
  .description("Download and install a host speech model")
  .option("--models-dir <dir>", "local speech model directory")
  .option("--model-server <url>", "development model server base URL")
  .action(async (id: string, options: { modelsDir?: string; modelServer?: string }) => {
    const manager = modelManager(options)
    const result = await manager.install(id, printModelProgress)
    process.stdout.write("\n")
    console.log(`installed ${result.spec.id} in ${result.dir}`)
  })

asrCommand
  .command("import <id> <source>")
  .description("Import a downloaded model archive or extracted directory")
  .option("--models-dir <dir>", "local speech model directory")
  .action(async (id: string, source: string, options: { modelsDir?: string }) => {
    const manager = modelManager(options)
    const result = await manager.import(id, source, printModelProgress)
    process.stdout.write("\n")
    console.log(`imported ${result.spec.id} in ${result.dir}`)
  })

asrCommand
  .command("remove <id>")
  .description("Delete an installed host speech model")
  .option("--models-dir <dir>", "local speech model directory")
  .action(async (id: string, options: { modelsDir?: string }) => {
    await modelManager(options).remove(id)
    console.log(`removed ${id}`)
  })

asrCommand
  .command("test")
  .description("Transcribe a WAV file with an installed host model")
  .requiredOption("--file <wav>", "16 kHz mono WAV file")
  .option("--model <id>", "model id")
  .option("--models-dir <dir>", "local speech model directory")
  .action(async (options: { file: string; model?: string; modelsDir?: string }) => {
    const manager = modelManager(options)
    const asr = new HostAsr(manager, options.model)
    try {
      const audio = new Uint8Array(await readFile(options.file))
      const result = await asr.transcribe(audio, options.model ? { modelId: options.model } : {})
      console.log(JSON.stringify(result, null, 2))
    } finally {
      asr.close()
    }
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

function modelManager(options: { modelsDir?: string; modelServer?: string }): HostModelManager {
  return new HostModelManager({
    ...(options.modelsDir ? { modelsDir: options.modelsDir } : {}),
    ...(options.modelServer ? { baseUrl: options.modelServer } : {}),
  })
}

function printModelProgress(progress: { phase: string; receivedBytes?: number; totalBytes?: number }): void {
  if (progress.phase === "downloading") {
    const percent = progress.totalBytes ? Math.floor(((progress.receivedBytes ?? 0) / progress.totalBytes) * 100) : 0
    process.stdout.write(`\r  downloading ${percent}% (${formatModelSize(progress.receivedBytes ?? 0)} / ${formatModelSize(progress.totalBytes ?? 0)})`)
  } else {
    process.stdout.write(`\r  ${progress.phase}          `)
  }
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
    transports: relayTransports(input),
  }
  return encodePairingOffer(offer, input.identity.publicKey)
}

function relayTransports(input: {
  config: HostConfig
  hostname: string
  port: number
  url?: string
}): import("@ocremote/protocol").Transport[] {
  const transports: import("@ocremote/protocol").Transport[] = [
    {
      kind: "lan",
      url: input.url ?? lanUrls(input.hostname, input.port)[0] ?? `ws://127.0.0.1:${input.port}/ws`,
      priority: 0,
    },
  ]
  if (input.config.relay) {
    transports.push({
      kind: "relay",
      url: input.config.relay.url,
      room: input.config.relay.room,
      clientToken: input.config.relay.clientToken,
      priority: 1,
    })
  }
  return transports
}

async function resolveRelay(input: {
  url?: string
  secret?: string
  room?: string
  newRoom: boolean
}): Promise<import("./config.ts").RelayConfig | undefined> {
  if (!input.url) return undefined
  const home = resolveHome()
  const identity = await loadOrCreateIdentity(home)
  const config = await loadConfig(home, {
    hostId: identity.hostId,
    name: process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
    lan: { hostname: "0.0.0.0", port: 8787 },
  })
  if (!input.newRoom && config.relay && config.relay.url === input.url && !input.room) return config.relay

  const secret = input.secret ?? process.env.RELAY_REGISTRATION_SECRET
  if (!secret) throw new Error("--relay-secret or RELAY_REGISTRATION_SECRET is required to register a relay room")
  const relay = await registerRelayRoom({
    relayUrl: input.url,
    secret,
    ...(input.room ? { room: input.room } : {}),
  })
  config.relay = relay
  await saveConfig(home, config)
  console.log(`registered relay room ${relay.room}`)
  return relay
}

function printOffer(url: string): void {
  qrcode.generate(url, { small: true }, (output) => console.log(output))
  console.log(`\nPairing link:\n${url}\n`)
}
