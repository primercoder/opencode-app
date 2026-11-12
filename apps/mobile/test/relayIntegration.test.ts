import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePairingOffer } from "@ocremote/protocol"
import { registerRelayRoom } from "../../host/src/relay.ts"
import { startHost } from "../../host/src/server.ts"
import { HostRuntime } from "../src/transport/hostRuntime.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe("relay end to end", () => {
  test("pairs and proxies through an opaque relay", async () => {
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
    let relay = spawnRelay(relayBinary, relayPort)
    cleanups.push(async () => {
      relay.kill()
      await rm(relayBinary, { force: true })
    })
    await waitFor(`http://127.0.0.1:${relayPort}/healthz`)

    const relayConfig = await registerRelayRoom({
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      secret: "test-secret",
    })

    const home = await mkdtemp(join(tmpdir(), "ocremote-relay-"))
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
      relaySecret: "test-secret",
    })
    cleanups.push(() => host.close())

    const code = await host.issuePairCode()
    const pairingUrl = await host.pairingOffer(code, "ws://127.0.0.1:1/ws")
    const offer = parsePairingOffer(pairingUrl)
    expect(offer.transports.map((transport) => transport.kind)).toEqual(["lan", "relay"])

    const runtime = HostRuntime.fromPairingOffer(offer, { autoReconnect: true })
    cleanups.push(() => runtime.disconnect())

    const session = await runtime.connect()
    expect(runtime.activeCandidate).toContain("role=client")
    expect(session.host.id).toBe(host.identity.hostId)
    expect(session.opencode.version).toBe("relay-2.2.7")

    const response = await runtime.request({ method: "GET", path: "/api/info" })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).version).toBe("relay-2.2.7")

    // Relay rooms live in memory. After a restart the host must re-register the
    // room and both ends must reconnect without re-pairing.
    relay.kill()
    await relay.exited
    await Bun.sleep(1_000)
    relay = spawnRelay(relayBinary, relayPort)
    await waitFor(`http://127.0.0.1:${relayPort}/healthz`)

    for (let attempt = 0; attempt < 60 && runtime.state !== "ready"; attempt += 1) {
      await Bun.sleep(500)
    }
    expect(runtime.state).toBe("ready")
    const recovered = await runtime.request({ method: "GET", path: "/api/info" })
    expect(recovered.status).toBe(200)
    expect(JSON.parse(recovered.body).version).toBe("relay-2.2.7")
  }, 60_000)
})

function spawnRelay(binary: string, port: number) {
  return Bun.spawn([binary], {
    env: {
      ...process.env,
      RELAY_LISTEN: `127.0.0.1:${port}`,
      RELAY_REGISTRATION_SECRET: "test-secret",
      RELAY_PUBLIC_URL: `ws://127.0.0.1:${port}/ws`,
    },
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
