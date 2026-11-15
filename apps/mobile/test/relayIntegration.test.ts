import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePairingOffer, parseRelayInviteLink, relayNoiseHandshake } from "@ocremote/protocol"
import { enrollRelaySubject } from "../../host/src/relay.ts"
import { startHost } from "../../host/src/server.ts"
import { HostRuntime } from "../src/transport/hostRuntime.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe("relay v4 end to end", () => {
  test("self-registers a host, enrolls a phone and survives a relay restart", async () => {
    const relayPort = await freePort()
    const relayDir = join(import.meta.dir, "../../relay")
    const relayBinary = join(tmpdir(), `ocremote-relay-test-${process.pid}-${Date.now()}`)
    const build = Bun.spawnSync(["bash", "-lc", `go build -trimpath -o '${relayBinary}' ./cmd/relay`], {
      cwd: relayDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (build.exitCode !== 0) {
      throw new Error(`relay build failed: ${build.stderr.toString()}`)
    }
    const dataDir = await mkdtemp(join(tmpdir(), "ocremote-relay-data-"))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const publicUrl = `ws://127.0.0.1:${relayPort}/ws`

    let relay = spawnRelay(relayBinary, dataDir, relayPort, publicUrl)
    cleanups.push(async () => {
      relay.kill()
      await rm(relayBinary, { force: true })
    })
    await waitFor(`http://127.0.0.1:${relayPort}/healthz`)
    const hostLink = adminHostLink(relayBinary, dataDir, publicUrl)

    const relayConfig = await enrollRelaySubject({
      link: hostLink,
      hostId: "host_relay_test",
      name: "relay-test-host",
    })
    expect(relayConfig.subjectId.startsWith("sub_")).toBe(true)
    expect(relayConfig.room.startsWith("room_")).toBe(true)
    expect(relayConfig.clientInvite?.startsWith("ocremote-relay://enroll#")).toBe(true)

    const home = await mkdtemp(join(tmpdir(), "ocremote-relay-host-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/api/info") {
          return Response.json({ version: "relay-2.2.7", hostname: "relay-test" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    cleanups.push(() => opencode.stop(true))

    const host = await startHost({
      homeDir: home,
      hostname: "127.0.0.1",
      port: 0,
      opencodeUrl: `http://127.0.0.1:${opencode.port}`,
      opencodePassword: "test-password",
      relay: relayConfig,
    })
    cleanups.push(() => host.close())

    const routes = await host.pairingRoutes()
    expect(routes.map((route) => route.kind)).toEqual(["relay"])
    const offer = parsePairingOffer(routes[0]!.offer)
    const relayTransport = offer.transports.find((transport) => transport.kind === "relay")
    if (!relayTransport || relayTransport.kind !== "relay" || !relayTransport.invite) {
      throw new Error("pairing offer did not include a relay phone invite")
    }
    const clientAccess = await enrollClient(relayTransport.invite, relayConfig.room)

    const runtime = HostRuntime.fromPairingOffer(offer, {
      autoReconnect: true,
      relayAuth: () => clientAccess,
    })
    cleanups.push(() => runtime.disconnect())

    const session = await runtime.connect()
    expect(runtime.activeCandidate).toContain("relay=1")
    expect(session.host.id).toBe(host.identity.hostId)
    expect(session.opencode.version).toBe("relay-2.2.7")

    const response = await runtime.request({ method: "GET", path: "/api/info" })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).version).toBe("relay-2.2.7")

    // Subjects are persisted in BoltDB. After a relay restart the same
    // subject secrets recover the room without a new invite or re-pairing.
    relay.kill()
    await relay.exited
    await Bun.sleep(1_000)
    relay = spawnRelay(relayBinary, dataDir, relayPort, publicUrl)
    await waitFor(`http://127.0.0.1:${relayPort}/healthz`)

    for (let attempt = 0; attempt < 60 && runtime.state !== "ready"; attempt += 1) {
      await Bun.sleep(500)
    }
    expect(runtime.state).toBe("ready")
    const recovered = await runtime.request({ method: "GET", path: "/api/info" })
    expect(recovered.status).toBe(200)
    expect(JSON.parse(recovered.body).version).toBe("relay-2.2.7")
  }, 90_000)
})

function adminHostLink(binary: string, dataDir: string, publicUrl: string): string {
  const result = Bun.spawnSync([binary, "admin", "--data-dir", dataDir, "--public-url", publicUrl, "link"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const link = result.stdout.toString().trim()
  if (result.exitCode !== 0 || !link.startsWith("ocremote-relay://host#")) {
    throw new Error(`relay host link failed: ${result.stderr.toString()}`)
  }
  return link
}

async function enrollClient(link: string, room: string): Promise<{ subjectId: string; secret: string; relayKey: string }> {
  const invite = parseRelayInviteLink(link)
  const socket = new WebSocket(invite.url)
  socket.binaryType = "arraybuffer"
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("relay client enroll connect failed"))
    socket.onclose = () => reject(new Error("relay client enroll closed"))
  })
  const result = await relayNoiseHandshake(
    socket,
    invite.rk,
    {
      t: "relay.hello",
      v: 3,
      kind: "client",
      invite: invite.invite,
      room,
      name: "test-phone",
    },
    10_000,
  )
  socket.close(1000, "enrolled")
  if (result.welcome.t === "relay.error") {
    throw new Error(`${String(result.welcome.code)}: ${String(result.welcome.message)}`)
  }
  return {
    subjectId: String(result.welcome.subjectId),
    secret: String(result.welcome.secret),
    relayKey: invite.rk,
  }
}

function spawnRelay(binary: string, dataDir: string, port: number, publicUrl: string) {
  return Bun.spawn([binary, "--data-dir", dataDir, "--listen", `127.0.0.1:${port}`, "--public-url", publicUrl], {
    stdout: "ignore",
    stderr: "inherit",
  })
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
  const port = server.port ?? 0
  server.stop(true)
  return port
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // relay is still compiling or starting
    }
    await Bun.sleep(200)
  }
  throw new Error(`timed out waiting for ${url}`)
}
