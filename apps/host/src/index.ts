#!/usr/bin/env bun
import { mkdir, open, readFile, rm } from "node:fs/promises"
import { isIP } from "node:net"
import { Command } from "commander"
import qrcode from "qrcode-terminal"
import { encodePairingOffer, fingerprintOfPublicKey, type PairingOffer, type Transport } from "@ocremote/protocol"
import { formatModelSize } from "@ocremote/models"
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
import { HostModelManager } from "./asr/modelManager.ts"
import { HostAsr } from "./asr/service.ts"
import { addPendingPair, revokeDevice } from "./pairing.ts"
import { registerRelayRoom } from "./relay.ts"
import { resolveOpencodeTarget } from "./opencode.ts"
import { directPairUrl, httpOrigin, startHost, type Host } from "./server.ts"
import {
  HOST_VERSION,
  clearState,
  control,
  isAlive,
  logPath,
  readPid,
  readState,
  socketPath,
  stateDir,
  waitForExit,
  writeState,
  type ClientEntry,
} from "./daemon.ts"

const DEFAULT_LISTEN = "127.0.0.1:8787"

const program = new Command()
  .name("ocremote")
  .description("Encrypted remote access for a local opencode 2.x server")
  .version(HOST_VERSION)

program.addHelpText(
  "after",
  `
Examples:
  ocremote start                        direct, local only (127.0.0.1:8787)
  ocremote start --listen 0.0.0.0:8787  direct, phones on the same LAN
  ocremote start --listen 192.168.1.23:8787
                                        direct, bind one network card
  ocremote start --foreground --listen 0.0.0.0:8787
                                        stay attached (tmux/systemd)
  ocremote start --relay ws://192.168.1.10:8080/ws --relay-secret SECRET
                                        through a self-hosted relay
  ocremote start --listen 0.0.0.0:8787 --relay ws://relay.example/ws \\
                 --relay-secret SECRET
                                        offer both direct and relay
  ocremote pair                        print a pairing QR for a running host
  ocremote status | clients | stop      manage the detached host

Connection modes: direct (LAN) and relay are independent. Direct is always on for
the --listen address; relay is used only when --relay is passed, even if a
room was saved by an earlier run.`,
)

program
  .command("start")
  .description("Start the host (detaches by default; --foreground keeps it attached)")
  .option(
    "-l, --listen <address>",
    `bind address: 127.0.0.1 = local only, 0.0.0.0 = all interfaces, or one LAN IP`,
    DEFAULT_LISTEN,
  )
  .option("--port <port>", "port override for --listen", (value) => Number(value))
  .option("-f, --foreground", "stay in the foreground (tmux/systemd)", false)
  .option("-d, --background", "detach (default; kept for scripts)", false)
  .option("-n, --name <name>", "host name shown on the phone")
  .option("--opencode-url <url>", "opencode server URL (requires --opencode-password)")
  .option("--opencode-password <password>", "opencode server password")
  .option("--pair", "print a pairing QR after startup", false)
  .option("--pair-url <ws-url>", "override the direct URL placed in the pairing offer")
  .option("--read-only", "issue a read-only pairing code", false)
  .option("--ttl <minutes>", "pairing code lifetime in minutes", (value) => Number(value), 5)
  .option("--relay <ws-url>", "relay WebSocket URL, e.g. ws://192.168.1.10:8080/ws")
  .option("--relay-secret <secret>", "relay registration secret (first run / new room)")
  .option("--relay-room <room>", "reuse a specific relay room")
  .option("--relay-new-room", "register a new relay room", false)
  .option("--models-dir <dir>", "local speech model directory")
  .option("--model-server <url>", "development model server base URL")
  .option("--asr-model <id>", "default host speech model id")
  .addHelpText(
    "after",
    `
Direct mode:
  --listen 127.0.0.1:8787  Default. Only this machine can connect. Useful with
                           "adb reverse tcp:8787 tcp:8787" or --pair-url.
  --listen 0.0.0.0:8787    Listen on every card; the QR offers all LAN IPv4s.
  --listen 192.168.1.23:8787
                           Bind one card. Use the address the phone can reach.
  Prints the pairing QR with --pair. When the host is already running, use
  "ocremote pair" instead.

Relay mode (independent, optional):
  --relay <ws-url>         Enables relay. Without it a saved room is ignored.
  --relay-secret <s>       Required the first time or with --relay-new-room.
                           Also read from RELAY_REGISTRATION_SECRET.
  --relay-room <room>      Reuse an existing room (needs its secret unless the
                           room was registered on this machine before).
  The QR offers direct first, then relay. Relay never sees plaintext.

Background:
  start detaches by default. Manage it with:
    ocremote status | clients | stop
  Use --foreground for tmux/systemd. Log: ~/.local/state/ocremote/host.log`,
  )
  .action(async (options: StartOptions) => {
    if (process.env.OCREMOTE_DAEMON_CHILD === "1") {
      await runForeground(options)
      return
    }
    if (options.foreground) {
      await runForeground(options)
      return
    }
    await startBackground(options)
  })

program
  .command("pair")
  .description("Print a pairing QR (talks to a running host when available)")
  .option("-l, --listen <address>", `direct address to put in the offer (default: ${DEFAULT_LISTEN})`, DEFAULT_LISTEN)
  .option("--lan", "deprecated alias for --listen 0.0.0.0:8787", false)
  .option("--port <port>", "port override for --listen", (value) => Number(value))
  .option("--url <ws-url>", "override the direct URL in the offer")
  .option("--read-only", "create a read-only device code", false)
  .option("--ttl <minutes>", "pairing code lifetime in minutes", (value) => Number(value), 5)
  .option("--relay", "include the saved relay room in the offer", false)
  .addHelpText(
    "after",
    `
Examples:
  ocremote pair                         ask the running host for a new code
  ocremote pair --read-only             read-only phone
  ocremote pair --listen 192.168.1.23:8787
                                        prepare a code before "start"
  ocremote pair --relay                 include the saved relay room

If the host is running this command uses its live state and ignores --listen.
If it is not running the code is stored in config.json and becomes usable on
the next "ocremote start".`,
  )
  .action(async (options: PairOptions) => {
    const listen = parseListen(options.lan ? "0.0.0.0" : options.listen, options.port)
    const scope: DeviceScope = options.readOnly ? "read" : "full"
    const ttl = Math.max(1, options.ttl)

    const running = await control<PairResult>({
      cmd: "pair",
      scope,
      ttlMinutes: ttl,
      ...(options.url ? { url: options.url } : {}),
    })
    if (running) {
      printPairing(running.offer, running.qrText, running.shortUrl)
      return
    }

    const home = resolveHome()
    const identity = await loadOrCreateIdentity(home)
    const config = await loadConfig(home, {
      hostId: identity.hostId,
      name: process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
      lan: { hostname: listen.hostname, port: listen.port },
    })
    const offer = await createOffer({
      config,
      identity,
      hostname: listen.hostname,
      port: listen.port,
      scope,
      ttlMs: ttl * 60_000,
      ...(options.url ? { url: options.url } : {}),
      ...(options.relay ? { includeRelay: true } : {}),
    })
    await saveConfig(home, config)
    printPairing(offer, offer)
    console.log("Start the host with: ocremote start --listen " + formatListen(listen))
  })

program
  .command("stop")
  .description("Stop the background host")
  .action(async () => {
    const state = await readState()
    const pid = state?.pid ?? (await readPid())
    if (!pid || !isAlive(pid)) {
      await clearState()
      console.log("host is not running")
      return
    }
    const stopped = await control({ cmd: "stop" }, 2_000)
    if (!stopped) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // already gone
      }
    }
    if (!(await waitForExit(pid))) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
      await waitForExit(pid, 2_000)
    }
    await clearState()
    console.log(`stopped host (pid ${pid})`)
  })

program
  .command("status")
  .description("Show the running host, listen address and client count")
  .action(async () => {
    const state = await readState()
    const pid = state?.pid ?? (await readPid())
    if (!pid || !isAlive(pid)) {
      await clearState()
      console.log("host is not running")
      return
    }
    const snapshot = await control<StatusResult>({ cmd: "status" })
    if (!snapshot) {
      console.log(`host process is running (pid ${pid}) but is not responding`)
      return
    }
    printStatus(snapshot)
  })

program
  .command("clients")
  .description("List phones connected to the running host")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: { json: boolean }) => {
    const clients = await control<ClientEntry[]>({ cmd: "clients" })
    if (!clients) {
      console.log("host is not running")
      return
    }
    if (options.json) {
      console.log(JSON.stringify(clients, null, 2))
      return
    }
    if (clients.length === 0) {
      console.log("no clients connected")
      return
    }
    console.log("ID  DEVICE                  PLATFORM   TRANSPORT  SCOPE  ADDRESS            CONNECTED")
    for (const client of clients) {
      console.log(
        [
          String(client.id).padEnd(3),
          truncate(client.name, 23).padEnd(23),
          truncate(client.platform, 10).padEnd(10),
          client.transport.padEnd(10),
          client.scope.padEnd(6),
          truncate(client.remoteAddress ?? "-", 18).padEnd(18),
          duration(Date.now() - (client.connectedAt ?? Date.now())),
        ].join(" "),
      )
    }
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
        `${device.id}  ${device.name}  ${device.platform}  ${device.scope}  ${device.revokedAt ? "revoked" : "active"}  lastSeen=${device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : "-"}`,
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
    console.log(`state: ${stateDir()}`)
  })

if (import.meta.main) {
  program.parseAsync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

type StartOptions = {
  listen: string
  lan: boolean
  port?: number
  background: boolean
  foreground: boolean
  name?: string
  opencodeUrl?: string
  opencodePassword?: string
  pair: boolean
  pairUrl?: string
  readOnly: boolean
  ttl: number
  relay?: string
  relaySecret?: string
  relayRoom?: string
  relayNewRoom: boolean
  modelsDir?: string
  modelServer?: string
  asrModel?: string
}

type PairOptions = {
  listen: string
  lan: boolean
  port?: number
  url?: string
  readOnly: boolean
  ttl: number
  relay: boolean
}

type Listen = {
  hostname: string
  port: number
}

type StatusResult = {
  pid: number
  startedAt: number
  listen: string
  lanUrls: string[]
  relay: { url: string; room: string } | null
  opencodeUrl: string
  opencodeVersion?: string
  clients: number
  logPath: string
}

type PairResult = {
  offer: string
  shortUrl?: string
  qrText: string
  expiresAt: number
}

async function runForeground(options: StartOptions): Promise<void> {
  const listen = parseListen(options.lan ? "0.0.0.0" : options.listen, options.port)
  const existingPid = (await readState())?.pid ?? (await readPid())
  if (isAlive(existingPid)) {
    throw new Error(`another host is already running (pid ${existingPid}). Use "ocremote stop" first.`)
  }
  await clearState()
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  await rm(socketPath(), { force: true })

  const relay = await resolveRelay(options)
  const host = await startHost({
    hostname: listen.hostname,
    port: listen.port,
    ...(options.name ? { name: options.name } : {}),
    ...(options.opencodeUrl ? { opencodeUrl: options.opencodeUrl } : {}),
    ...(options.opencodePassword ? { opencodePassword: options.opencodePassword } : {}),
    ...(relay ? { relay } : {}),
    ...(options.relaySecret ? { relaySecret: options.relaySecret } : {}),
    ...(process.env.RELAY_REGISTRATION_SECRET && !options.relaySecret
      ? { relaySecret: process.env.RELAY_REGISTRATION_SECRET }
      : {}),
    ...(options.modelsDir ? { modelsDir: options.modelsDir } : {}),
    ...(options.modelServer ? { modelBaseUrl: options.modelServer } : {}),
    ...(options.asrModel ? { asrModelId: options.asrModel } : {}),
  })

  const state = {
    pid: process.pid,
    startedAt: Date.now(),
    listen: formatListen(listen),
    lanUrls: host.lanUrls,
    relay: relay ? { url: relay.url, room: relay.room } : null,
    opencodeUrl: host.target.url,
    ...(host.target.version ? { opencodeVersion: host.target.version } : {}),
    socketPath: socketPath(),
    logPath: logPath(),
    version: HOST_VERSION,
  }
  await writeState(state)

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      host.server.stop(true)
      controlServer.stop(true)
      await host.close()
    } finally {
      await rm(socketPath(), { force: true })
      await clearState()
      process.exit(0)
    }
  }

  const controlServer = Bun.serve({
    unix: socketPath(),
    async fetch(request) {
      let body: Record<string, unknown> = {}
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return Response.json({ ok: false, error: "invalid control request" }, { status: 400 })
      }
      try {
        switch (body.cmd) {
          case "status": {
            const data: StatusResult = {
              ...state,
              clients: host.clients().length,
            }
            return Response.json({ ok: true, data })
          }
          case "clients":
            return Response.json({ ok: true, data: host.clients() })
          case "pair": {
            const scope: DeviceScope = body.scope === "read" ? "read" : "full"
            const ttl = typeof body.ttlMinutes === "number" ? Math.max(1, body.ttlMinutes) : 5
            const code = await host.issuePairCode(scope, ttl * 60_000)
            const directUrl =
              typeof body.url === "string" ? body.url : pairUrlFor(listen, options.pairUrl)
            const offer = await host.pairingOffer(code, directUrl)
            const shortUrl = shortPairUrl(host, directUrl, offer)
            const result: PairResult = {
              offer,
              ...(shortUrl ? { shortUrl } : {}),
              qrText: shortUrl ?? offer,
              expiresAt: Date.now() + ttl * 60_000,
            }
            return Response.json({ ok: true, data: result })
          }
          case "stop":
            setTimeout(() => void shutdown(), 20)
            return Response.json({ ok: true, data: { stopping: true } })
          default:
            return Response.json({ ok: false, error: "unknown control command" }, { status: 400 })
        }
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : "control request failed" },
          { status: 500 },
        )
      }
    },
  })

  console.log(`ocremote ${HOST_VERSION}`)
  console.log(`opencode  ${host.target.url} (${host.target.version ?? "unknown"})`)
  console.log(`listen    ${formatListen(listen)}`)
  printTransports(host, listen)
  const caps = (await host.asr.capabilities()) as { available?: boolean; models?: Array<{ id: string }> }
  console.log(
    `ASR       ${caps.available ? caps.models?.map((model) => model.id).join(", ") : "unavailable (ocremote asr install host-sense-voice-int8)"}`,
  )
  console.log(`log       ${logPath()}`)
  console.log("")

  if (options.pair) {
    const code = await host.issuePairCode(options.readOnly ? "read" : "full", Math.max(1, options.ttl) * 60_000)
    const directUrl = pairUrlFor(listen, options.pairUrl)
    const offer = await host.pairingOffer(code, directUrl)
    const shortUrl = shortPairUrl(host, directUrl, offer)
    printPairing(offer, shortUrl ?? offer, shortUrl)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  // Bun keeps the process alive while the servers are listening.
  await new Promise<void>(() => undefined)
}

async function startBackground(options: StartOptions): Promise<void> {
  const existingPid = (await readState())?.pid ?? (await readPid())
  if (isAlive(existingPid)) {
    throw new Error(`another host is already running (pid ${existingPid}). Use "ocremote stop" first.`)
  }
  await clearState()
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  const log = await open(logPath(), "a", 0o600)
  const command = selfCommand()
  const args = [
    ...command.prefix,
    "start",
    "--listen",
    options.lan ? "0.0.0.0" : options.listen,
    ...(options.port ? ["--port", String(options.port)] : []),
    ...(options.name ? ["--name", options.name] : []),
    ...(options.opencodeUrl ? ["--opencode-url", options.opencodeUrl] : []),
    ...(options.opencodePassword ? ["--opencode-password", options.opencodePassword] : []),
    ...(options.readOnly ? ["--read-only"] : []),
    ...(options.relay ? ["--relay", options.relay] : []),
    ...(options.relaySecret ? ["--relay-secret", options.relaySecret] : []),
    ...(options.relayRoom ? ["--relay-room", options.relayRoom] : []),
    ...(options.relayNewRoom ? ["--relay-new-room"] : []),
    ...(options.modelsDir ? ["--models-dir", options.modelsDir] : []),
    ...(options.modelServer ? ["--model-server", options.modelServer] : []),
    ...(options.asrModel ? ["--asr-model", options.asrModel] : []),
  ]
  const child = Bun.spawn(args, {
    cwd: command.cwd,
    env: { ...process.env, OCREMOTE_DAEMON_CHILD: "1" },
    stdio: ["ignore", log.fd, log.fd],
  })
  child.unref()

  const deadline = Date.now() + 20_000
  let snapshot: StatusResult | undefined
  while (Date.now() < deadline) {
    snapshot = await control<StatusResult>({ cmd: "status" }, 1_000)
    if (snapshot) break
    if (child.exitCode !== null && child.exitCode !== 0) break
    await Bun.sleep(150)
  }
  log.close().catch(() => undefined)

  if (!snapshot) {
    const tail = await readFile(logPath(), "utf8").catch(() => "")
    console.error("host failed to start. Last log lines:")
    console.error(tail.split("\n").slice(-20).join("\n"))
    process.exitCode = 1
    return
  }

  console.log(`ocremote ${HOST_VERSION} started in the background (pid ${snapshot.pid})`)
  printStatus(snapshot)
  if (options.pair) {
    const result = await control<PairResult>({
      cmd: "pair",
      scope: options.readOnly ? "read" : "full",
      ttlMinutes: Math.max(1, options.ttl),
      ...(options.pairUrl ? { url: options.pairUrl } : {}),
    })
    if (result) printPairing(result.offer, result.qrText, result.shortUrl)
  }
}

function selfCommand(): { prefix: string[]; cwd: string } {
  const entry = process.argv[1]
  // `bun src/index.ts` and `bun app/main.js` keep the script in argv[1];
  // a compiled binary has the first CLI argument there instead.
  if (entry && (entry.endsWith(".ts") || entry.endsWith(".js") || entry.endsWith(".mjs"))) {
    return { prefix: [process.execPath, entry], cwd: process.cwd() }
  }
  return { prefix: [process.execPath], cwd: process.cwd() }
}

function parseListen(value: string, portOverride?: number): Listen {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("--listen cannot be empty")
  let hostname = trimmed
  let port = portOverride

  if (trimmed.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(trimmed)
    if (!match) throw new Error(`invalid --listen address: ${value}`)
    hostname = match[1] ?? ""
    if (match[2]) port = Number(match[2])
  } else if (trimmed.includes(":")) {
    const index = trimmed.lastIndexOf(":")
    hostname = trimmed.slice(0, index) || "0.0.0.0"
    port = Number(trimmed.slice(index + 1))
  } else if (/^\d+$/u.test(trimmed)) {
    hostname = "127.0.0.1"
    port = Number(trimmed)
  }

  if (hostname === "localhost") hostname = "127.0.0.1"
  if (isIP(hostname) === 0) throw new Error(`--listen needs an IP address, got: ${hostname}`)
  const resolvedPort = port ?? 8787
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    throw new Error(`--listen port must be 1-65535, got: ${resolvedPort}`)
  }
  return { hostname, port: resolvedPort }
}

function formatListen(listen: Listen): string {
  const host = listen.hostname.includes(":") ? `[${listen.hostname}]` : listen.hostname
  return `${host}:${listen.port}`
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
}

function pairUrlFor(listen: Listen, override: string | undefined): string {
  if (override) return override
  return directPairUrl(listen.hostname, listen.port)
}

function shortPairUrl(host: Host, direct: string, offer: string): string | undefined {
  try {
    const url = new URL(direct)
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost"
    if (loopback) return undefined
    return host.shortenOffer(offer, httpOrigin(direct))
  } catch {
    return undefined
  }
}

function printPairing(offer: string, qrText: string, shortUrl?: string): void {
  console.log("")
  if (shortUrl) {
    qrcode.generate(qrText, { small: true }, (output) => console.log(output))
    console.log("")
    console.log(`扫码地址：${shortUrl}`)
  } else {
    console.log("这次没有可扫码的局域网地址（只监听回环），请直接粘贴下面的链接。")
    console.log("要让手机扫码：用 --listen 0.0.0.0:8787，或加 --pair-url ws://<局域网IP>:8787/ws。")
  }
  console.log("配对链接（可粘贴到手机）：")
  console.log(offer)
  console.log("")
  console.log("手机：OC Remote → 添加主机 → 扫码或粘贴链接。")
}

function printStatus(state: StatusResult): void {
  console.log(`listen    ${state.listen}`)
  if (state.lanUrls.length > 0) console.log(`direct    ${state.lanUrls.join("  ")}`)
  console.log(
    `relay     ${state.relay ? `${state.relay.url} · room ${state.relay.room}` : "off"}`,
  )
  console.log(`opencode  ${state.opencodeUrl} (${state.opencodeVersion ?? "unknown"})`)
  console.log(`clients   ${state.clients}`)
  console.log(`uptime    ${duration(Date.now() - state.startedAt)}`)
  console.log(`log       ${state.logPath}`)
}

function printTransports(host: Host, listen: Listen): void {
  if (isLoopback(listen.hostname)) {
    console.log("direct    local only — phones cannot connect until you use --listen 0.0.0.0 or a LAN IP")
    return
  }
  console.log(`direct    ${host.lanUrls.join("  ")}`)
  if (host.relay) console.log(`relay     ${host.relay.url} · room ${host.relay.room}`)
  else console.log("relay     off")
}

async function resolveRelay(options: StartOptions): Promise<RelayConfig | undefined> {
  if (!options.relay) return undefined
  const home = resolveHome()
  const identity = await loadOrCreateIdentity(home)
  const config = await loadConfig(home, {
    hostId: identity.hostId,
    name: options.name ?? process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
    lan: { hostname: "127.0.0.1", port: 8787 },
  })
  if (!options.relayNewRoom && config.relay?.url === options.relay) {
    if (options.relaySecret) {
      await registerRelayRoom({
        relayUrl: config.relay.url,
        secret: options.relaySecret,
        room: config.relay.room,
        hostToken: config.relay.hostToken,
        clientToken: config.relay.clientToken,
      })
    }
    return config.relay
  }
  const secret = options.relaySecret ?? process.env.RELAY_REGISTRATION_SECRET
  if (!secret) {
    throw new Error(
      "relay registration needs --relay-secret (or RELAY_REGISTRATION_SECRET) the first time a room is created",
    )
  }
  const relay = await registerRelayRoom({
    relayUrl: options.relay,
    secret,
    ...(options.relayRoom ? { room: options.relayRoom } : {}),
  })
  config.relay = relay
  await saveConfig(home, config)
  console.log(`registered relay room ${relay.room}`)
  return relay
}

async function createOffer(input: {
  config: HostConfig
  identity: Identity
  hostname: string
  port: number
  scope: DeviceScope
  ttlMs: number
  url?: string
  includeRelay?: boolean
}): Promise<string> {
  const { code, pending } = addPendingPair(input.config, input.scope, input.ttlMs)
  const transports: Transport[] = [
    {
      kind: "lan",
      url: input.url ?? directPairUrl(input.hostname, input.port),
      priority: 0,
    },
  ]
  if (input.includeRelay && input.config.relay) {
    transports.push({
      kind: "relay",
      url: input.config.relay.url,
      room: input.config.relay.room,
      clientToken: input.config.relay.clientToken,
      priority: 1,
    })
  }
  const offer: PairingOffer = {
    v: 1,
    hostId: input.identity.hostId,
    name: input.config.name,
    pk: "",
    fingerprint: fingerprintOfPublicKey(input.identity.publicKey),
    pairCode: code,
    expiresAt: pending.expiresAt,
    transports,
  }
  return encodePairingOffer(offer, input.identity.publicKey)
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
    process.stdout.write(
      `\r  downloading ${percent}% (${formatModelSize(progress.receivedBytes ?? 0)} / ${formatModelSize(progress.totalBytes ?? 0)})`,
    )
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
    lan: { hostname: "127.0.0.1", port: 8787 },
  })
  return { home, config }
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
