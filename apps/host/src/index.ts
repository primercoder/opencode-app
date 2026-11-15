#!/usr/bin/env bun
import { mkdir, open, readFile, rm } from "node:fs/promises"
import { isIP } from "node:net"
import { Command } from "commander"
import qrcode from "qrcode-terminal"
import { base64UrlEncode, fingerprintOfPublicKey, parseRelayInviteLink } from "@ocremote/protocol"
import { formatModelSize } from "@ocremote/models"
import {
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
import { HostModelManager } from "./asr/modelManager.ts"
import { HostAsr } from "./asr/service.ts"
import { revokeDevice } from "./pairing.ts"
import { enrollRelaySubject } from "./relay.ts"
import { resolveOpencodeTarget } from "./opencode.ts"
import { httpOrigin, lanUrls, startHost, type DirectStatus, type Host, type PairRoute } from "./server.ts"
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
  type HostState,
} from "./daemon.ts"

const program = new Command()
  .name("ocremote")
  .description("Encrypted remote access for a local opencode 2.x server")
  .version(HOST_VERSION)

program.addHelpText(
  "after",
  `
Common workflows:
  Direct on the same Wi-Fi
    ocremote start
    ocremote direct 0.0.0.0:8787
    ocremote pair

  Relay only (phone and computer on different networks)
    ocremote start
    ocremote relay 'ocremote-relay://host#...'
    ocremote pair

  Direct and relay together
    ocremote start
    ocremote direct 192.168.1.20:8787
    ocremote relay 'ocremote-relay://host#...'
    ocremote pair

  Change routes while the host is running
    ocremote direct 192.168.1.20:8787
    ocremote relay off
    ocremote direct off

  Inspect or stop
    ocremote status
    ocremote clients
    ocremote stop

Connection modes:
  Direct and relay are independent. The host only offers routes that are
  actually enabled. Pair prints a separate QR and link for every enabled route.
  A loopback-only direct listener is never offered to phones.`,
)

program
  .command("start")
  .description("Start the host with the saved direct/relay settings")
  .option("-f, --foreground", "stay in the foreground (systemd/tmux)", false)
  .option("-n, --name <name>", "host name shown on the phone")
  .option("--opencode-url <url>", "opencode server URL (requires --opencode-password)")
  .option("--opencode-password <password>", "opencode server password")
  .option("--models-dir <dir>", "local speech model directory")
  .option("--model-server <url>", "development model server base URL")
  .option("--asr-model <id>", "default host speech model id")
  .addHelpText(
    "after",
    `
Examples:
  ocremote start
      Start in the background with the saved config.

  ocremote start --foreground
      Stay attached for systemd or tmux.

  ocremote start --foreground --name 'Study PC'
      Override the display name for this run.

First run:
  ocremote start
  ocremote direct 0.0.0.0:8787
  ocremote pair
  # or
  ocremote relay 'ocremote-relay://host#...'
  ocremote pair`,
  )
  .action(async (options: StartOptions) => {
    if (process.env.OCREMOTE_DAEMON_CHILD === "1" || options.foreground) {
      await runForeground(options)
      return
    }
    await startBackground(options)
  })

program
  .command("direct [address]")
  .description("Show, enable, update or disable direct/LAN access")
  .addHelpText(
    "after",
    `
Address:
  0.0.0.0:8787          listen on every interface; QR uses a LAN IPv4
  192.168.1.20:8787     bind one interface
  127.0.0.1:8787        local only; not offered to phones
  off                   disable direct

Examples:
  ocremote direct 0.0.0.0:8787
  ocremote direct 192.168.1.20:8787
  ocremote direct off
  ocremote direct

Changes apply immediately while the host is running and persist for the next
start. Loopback-only direct is never placed in a phone pairing offer.`,
  )
  .action(async (address: string | undefined) => {
    const running = await currentStatus()
    if (!address) {
      const current = running?.direct ?? (await loadLocal()).config.direct
      if (!current) {
        console.log("direct is off")
        return
      }
      console.log(`direct ${current.hostname}:${current.port}`)
      if (isLoopbackHostname(current.hostname)) console.log("local only — not offered to phones")
      return
    }
    if (address.trim().toLowerCase() === "off") {
      if (running) await requireControl({ cmd: "direct.off" })
      else {
        const { home, config } = await loadLocal()
        delete config.direct
        await saveConfig(home, config)
      }
      console.log("direct off")
      return
    }
    const listen = parseListen(address)
    const status = running
      ? await requireControl<DirectStatus>({ cmd: "direct.set", hostname: listen.hostname, port: listen.port })
      : await saveDirect(listen)
    console.log(`direct ${status.hostname}:${status.port}`)
    if (isLoopbackHostname(status.hostname)) {
      console.log("local only — phones cannot use this route")
    } else {
      console.log(`phone URL ${directUrl(status)}`)
    }
  })

program
  .command("relay [link]")
  .description("Show, enroll or disable relay access")
  .option("--ca <pem>", "CA certificate for an optional self-signed TLS relay")
  .addHelpText(
    "after",
    `
Examples:
  ocremote relay
  ocremote relay 'ocremote-relay://host#...'
  ocremote relay on
  ocremote relay off

The relay prints a reusable host link at startup. Copy it once; the host keeps
the returned subject secret. "off" keeps the saved identity so "on" (or the
same host link) can re-enable it without consuming another relay host slot.
Changes apply immediately while the host is running and persist for the next
start.`,
  )
  .action(async (link: string | undefined, options: { ca?: string }) => {
    const running = await currentStatus()
    const local = await loadLocal()
    const saved = local.config.relay
    if (!link) {
      const current = running?.relay
      if (current) {
        console.log(`relay ${current.url} · room ${current.room}`)
        return
      }
      if (saved) {
        console.log(`relay off (saved ${saved.url} · room ${saved.room})`)
      } else {
        console.log("relay is off")
      }
      return
    }
    const action = link.trim().toLowerCase()
    if (action === "off") {
      if (running) await requireControl({ cmd: "relay.off" })
      else if (saved) {
        saved.enabled = false
        await saveConfig(local.home, local.config)
      }
      console.log("relay off")
      return
    }
    if (action === "on") {
      if (!saved) throw new Error("no saved relay identity. Use: ocremote relay '<host-link>'")
      saved.enabled = true
      if (running) await requireControl({ cmd: "relay.set", relay: saved })
      else await saveConfig(local.home, local.config)
      console.log(`relay ${saved.url} · room ${saved.room}`)
      return
    }

    const parsed = parseRelayInviteLink(link)
    const sameRelay = saved && sameRelayUrl(saved.url, parsed.url) && saved.relayKey === parsed.rk
    let relay = saved
    if (!sameRelay) {
      const identity = await loadOrCreateIdentity(local.home, local.config.name)
      relay = await enrollRelaySubject({
        link,
        hostId: identity.hostId,
        name: local.config.name,
        hostPublicKey: base64UrlEncode(identity.publicKey),
        ...(options.ca ? { caPath: options.ca } : {}),
      })
    }
    if (!relay) throw new Error("relay enrollment failed")
    relay.enabled = true
    if (running) {
      await requireControl({ cmd: "relay.set", relay, ...(options.ca ? { caPath: options.ca } : {}) })
    } else {
      local.config.relay = relay
      await saveConfig(local.home, local.config)
    }
    console.log(`relay ${relay.url} · room ${relay.room}`)
  })

program
  .command("pair")
  .description("Print one QR/link for every enabled route")
  .option("--read-only", "create read-only device codes", false)
  .option("--ttl <minutes>", "pairing code lifetime in minutes", (value) => Number(value), 5)
  .option("--json", "print machine-readable JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  ocremote pair
  ocremote pair --read-only
  ocremote pair --ttl 10
  ocremote pair --json

The host must be running. Every enabled route gets its own one-time code:
  Direct — same LAN
  Relay  — any network
If only relay is enabled, no loopback direct route is printed. If only direct
is enabled, no relay route is printed.`,
  )
  .action(async (options: { readOnly: boolean; ttl: number; json: boolean }) => {
    const ttl = Math.max(1, Math.floor(options.ttl))
    const routes = await requireControl<PairRoute[]>({
      cmd: "pair",
      scope: options.readOnly ? "read" : "full",
      ttlMinutes: ttl,
    })
    if (options.json) {
      console.log(JSON.stringify(routes, null, 2))
      return
    }
    printPairing(routes)
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
  .description("Show the running host and its enabled routes")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options: { json: boolean }) => {
    const snapshot = await currentStatus()
    if (!snapshot) {
      console.log("host is not running")
      return
    }
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2))
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
    const { config } = await loadLocal()
    console.log(`host id: ${identity.hostId}`)
    console.log(`fingerprint: ${fingerprintOfPublicKey(identity.publicKey)}`)
    console.log(`opencode: ${target.url} (${target.version ?? "unknown"})`)
    console.log(`direct: ${config.direct ? `${config.direct.hostname}:${config.direct.port}` : "off"}`)
    console.log(`relay: ${config.relay ? `${config.relay.url} room=${config.relay.room}` : "off"}`)
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
  foreground: boolean
  name?: string
  opencodeUrl?: string
  opencodePassword?: string
  modelsDir?: string
  modelServer?: string
  asrModel?: string
}

type StatusResult = {
  pid: number
  startedAt: number
  direct?: DirectStatus
  relay: { url: string; room: string; state?: string } | null
  opencodeUrl: string
  opencodeVersion?: string
  clients: number
  logPath: string
  version: string
}

type PairResult = PairRoute & {
  qrText: string
  shortUrl?: string
}

async function runForeground(options: StartOptions): Promise<void> {
  const existingPid = (await readState())?.pid ?? (await readPid())
  if (isAlive(existingPid)) {
    throw new Error(`another host is already running (pid ${existingPid}). Use "ocremote stop" first.`)
  }
  await clearState()
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  await rm(socketPath(), { force: true })

  const host = await startHost({
    ...(options.name ? { name: options.name } : {}),
    ...(options.opencodeUrl ? { opencodeUrl: options.opencodeUrl } : {}),
    ...(options.opencodePassword ? { opencodePassword: options.opencodePassword } : {}),
    ...(options.modelsDir ? { modelsDir: options.modelsDir } : {}),
    ...(options.modelServer ? { modelBaseUrl: options.modelServer } : {}),
    ...(options.asrModel ? { asrModelId: options.asrModel } : {}),
  })

  const currentDirect = host.direct()
  const currentRelay = host.relay()
  const state: HostState = {
    pid: process.pid,
    startedAt: Date.now(),
    ...(currentDirect ? { direct: currentDirect } : {}),
    relay: currentRelay ? { url: currentRelay.url, room: currentRelay.room, state: currentRelay.state } : null,
    opencodeUrl: host.target.url,
    ...(host.target.version ? { opencodeVersion: host.target.version } : {}),
    socketPath: socketPath(),
    logPath: logPath(),
    version: HOST_VERSION,
  }
  await writeState(state)

  let controlServer: Bun.Server<unknown> | undefined
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      controlServer?.stop(true)
      await host.close()
    } finally {
      await rm(socketPath(), { force: true })
      await clearState()
      process.exit(0)
    }
  }

  const snapshot = async (): Promise<StatusResult> => {
    const direct = host.direct()
    const relay = host.relay()
    const result: StatusResult = {
      ...state,
      relay: relay ? { url: relay.url, room: relay.room, state: relay.state } : null,
      clients: host.clients().length,
    }
    if (direct) result.direct = direct
    return result
  }

  controlServer = Bun.serve({
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
          case "status":
            return Response.json({ ok: true, data: await snapshot() })
          case "clients":
            return Response.json({ ok: true, data: host.clients() })
          case "pair": {
            const scope: DeviceScope = body.scope === "read" ? "read" : "full"
            const ttl = typeof body.ttlMinutes === "number" ? Math.max(1, body.ttlMinutes) : 5
            const routes = await host.pairingRoutes({
              scope,
              ttlMs: ttl * 60_000,
              ...(typeof body.directUrl === "string" ? { directUrl: body.directUrl } : {}),
            })
            const result: PairResult[] = routes.map((route) => {
              const shortUrl =
                route.kind === "direct" ? host.shortenOffer(route.offer, httpOrigin(route.url)) : undefined
              return {
                ...route,
                ...(shortUrl ? { shortUrl } : {}),
                qrText: shortUrl ?? route.offer,
              }
            })
            return Response.json({ ok: true, data: result })
          }
          case "direct.set": {
            const hostname = typeof body.hostname === "string" ? body.hostname : ""
            const port = typeof body.port === "number" ? body.port : 0
            if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
              return Response.json({ ok: false, error: "invalid direct address" }, { status: 400 })
            }
            const direct = await host.setDirect({ hostname, port })
            if (direct) state.direct = direct
            await writeState(state)
            return Response.json({ ok: true, data: direct })
          }
          case "direct.off": {
            await host.setDirect(null)
            delete state.direct
            await writeState(state)
            return Response.json({ ok: true, data: null })
          }
          case "relay.set": {
            const relay = body.relay as RelayConfig | undefined
            if (!relay || typeof relay.url !== "string" || typeof relay.secret !== "string") {
              return Response.json({ ok: false, error: "invalid relay configuration" }, { status: 400 })
            }
            await host.setRelay(relay, typeof body.caPath === "string" ? body.caPath : undefined)
            const current = host.relay()
            state.relay = current ? { url: current.url, room: current.room, state: current.state } : null
            await writeState(state)
            return Response.json({ ok: true, data: current })
          }
          case "relay.off": {
            await host.setRelay(null)
            state.relay = null
            await writeState(state)
            return Response.json({ ok: true, data: null })
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
  printTransports(host)
  const caps = (await host.asr.capabilities()) as { available?: boolean; models?: Array<{ id: string }> }
  console.log(
    `ASR       ${caps.available ? caps.models?.map((model) => model.id).join(", ") : "unavailable (ocremote asr install host-sense-voice-int8)"}`,
  )
  console.log(`log       ${logPath()}`)
  console.log("")
  const phoneDirect = host.direct()
  if ((!phoneDirect || !isPhoneDirect(phoneDirect)) && !host.relay()) {
    printRouteHint()
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

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
    "--foreground",
    ...(options.name ? ["--name", options.name] : []),
    ...(options.opencodeUrl ? ["--opencode-url", options.opencodeUrl] : []),
    ...(options.opencodePassword ? ["--opencode-password", options.opencodePassword] : []),
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
  if ((!snapshot.direct || !isPhoneDirect(snapshot.direct)) && !snapshot.relay) printRouteHint()
}

function selfCommand(): { prefix: string[]; cwd: string } {
  const entry = process.argv[1]
  if (entry && (entry.endsWith(".ts") || entry.endsWith(".js") || entry.endsWith(".mjs"))) {
    return { prefix: [process.execPath, entry], cwd: process.cwd() }
  }
  return { prefix: [process.execPath], cwd: process.cwd() }
}

async function currentStatus(): Promise<StatusResult | undefined> {
  const pid = (await readState())?.pid ?? (await readPid())
  if (!pid || !isAlive(pid)) return undefined
  return control<StatusResult>({ cmd: "status" })
}

async function requireControl<T = unknown>(command: Parameters<typeof control>[0]): Promise<T> {
  const value = await control<T>(command)
  if (value === undefined) throw new Error("host is not running. Start it with: ocremote start")
  return value
}

async function saveDirect(listen: DirectConfig): Promise<DirectStatus> {
  const { home, config } = await loadLocal()
  config.direct = listen
  await saveConfig(home, config)
  return { ...listen, urls: lanUrls(listen.hostname, listen.port) }
}

async function loadLocal(): Promise<{ home: string; config: HostConfig }> {
  const home = resolveHome()
  const identity = await loadOrCreateIdentity(home)
  const config = await loadConfig(home, {
    hostId: identity.hostId,
    name: process.env.OCREMOTE_HOST_NAME ?? "ocremote-host",
  })
  return { home, config }
}

function sameRelayUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return left === right
  }
}

function parseListen(value: string): DirectConfig {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("direct address cannot be empty")
  let hostname = trimmed
  let port = 8787
  if (trimmed.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(trimmed)
    if (!match) throw new Error(`invalid direct address: ${value}`)
    hostname = match[1] ?? ""
    if (match[2]) port = Number(match[2])
  } else if (trimmed.includes(":")) {
    const index = trimmed.lastIndexOf(":")
    hostname = trimmed.slice(0, index) || "0.0.0.0"
    port = Number(trimmed.slice(index + 1))
  } else {
    throw new Error(`direct address needs IP:port, got: ${value}`)
  }
  if (hostname === "localhost") hostname = "127.0.0.1"
  if (isIP(hostname) === 0) throw new Error(`direct address needs an IP, got: ${hostname}`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`direct port must be 1-65535, got: ${port}`)
  }
  return { hostname, port }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
}

function isPhoneDirect(status: DirectStatus): boolean {
  if (isLoopbackHostname(status.hostname)) return false
  return status.urls.some((url) => {
    try {
      return !isLoopbackHostname(new URL(url).hostname)
    } catch {
      return false
    }
  })
}

function directUrl(status: DirectStatus): string {
  if (status.urls.length > 0) {
    return status.urls.find((url) => !url.includes("127.0.0.1") && !url.includes("[::1]")) ?? status.urls[0]!
  }
  return `ws://${status.hostname}:${status.port}/ws`
}

function printStatus(state: StatusResult): void {
  const direct = state.direct && isPhoneDirect(state.direct) ? state.direct : undefined
  if (direct) console.log(`direct    ${directUrl(direct)}`)
  if (state.relay) console.log(`relay     ${state.relay.url} · room ${state.relay.room}`)
  if (!direct && !state.relay) console.log("routes    none")
  console.log(`opencode  ${state.opencodeUrl} (${state.opencodeVersion ?? "unknown"})`)
  console.log(`clients   ${state.clients}`)
  console.log(`uptime    ${duration(Date.now() - state.startedAt)}`)
  console.log(`log       ${state.logPath}`)
}

function printTransports(host: Host): void {
  const current = host.direct()
  const direct = current && isPhoneDirect(current) ? current : undefined
  const relay = host.relay()
  if (direct) {
    console.log(`direct    ${directUrl(direct)}`)
  }
  if (relay) {
    console.log(`relay     ${relay.url} · room ${relay.room}`)
  }
  if (!direct && !relay) {
    console.log("routes    none")
  }
}

function printRouteHint(): void {
  console.log("No phone-reachable route is enabled. Choose one:")
  console.log("  ocremote direct 0.0.0.0:8787")
  console.log("  ocremote relay 'ocremote-relay://host#...'")
  console.log("")
}

function printPairing(routes: PairRoute[]): void {
  if (routes.length === 0) {
    console.log("no phone-reachable route is enabled")
    return
  }
  for (const [index, route] of routes.entries()) {
    if (index > 0) console.log("")
    if (route.kind === "direct") {
      console.log("Direct · same LAN")
      console.log(`  ${route.url}`)
    } else {
      console.log("Relay · any network")
      console.log(`  ${route.url} · room ${route.room ?? "-"}`)
      if (!route.hasInvite) {
        console.log("  note: no fresh phone invite is available yet. Start the host and scan again if this phone is new.")
      }
    }
    console.log("")
    qrcode.generate(route.shortUrl ?? route.offer, { small: true }, (output) => console.log(output))
    if (route.shortUrl) console.log(`\n  short URL: ${route.shortUrl}`)
    console.log("  pairing link:")
    console.log(`  ${route.offer}`)
    console.log("")
    console.log("  Phone: OC Remote → Add host → Scan this QR or paste the link.")
  }
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
