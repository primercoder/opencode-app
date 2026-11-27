import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePairingOffer } from "@ocremote/protocol"
import { loadConfig } from "../src/config.ts"
import { startHost } from "../src/server.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe("host route configuration", () => {
  test("migrates a LAN v1 config but drops loopback-only direct", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-config-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ v: 1, hostId: "host_a", name: "A", lan: { hostname: "192.168.1.5", port: 8787 }, devices: [], pendingPairs: [] }),
    )
    const migrated = await loadConfig(home, { hostId: "host_a", name: "A" })
    expect(migrated.v).toBe(2)
    expect(migrated.direct).toEqual({ hostname: "192.168.1.5", port: 8787 })

    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ v: 1, hostId: "host_a", name: "A", lan: { hostname: "127.0.0.1", port: 8787 }, devices: [], pendingPairs: [] }),
    )
    const loopback = await loadConfig(home, { hostId: "host_a", name: "A" })
    expect(loopback.direct).toBeUndefined()
  })

  test("direct can be enabled and disabled at runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-live-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ version: "live-routes" })
      },
    })
    cleanups.push(() => opencode.stop(true))

    const host = await startHost({
      homeDir: home,
      direct: null,
      relay: null,
      opencodeUrl: `http://127.0.0.1:${opencode.port}`,
      opencodePassword: "x",
    })
    cleanups.push(() => host.close())

    expect(host.direct()).toBeUndefined()
    expect(host.relay()).toBeUndefined()
    await expect(host.pairingRoutes()).rejects.toThrow(/no phone-reachable transport/u)

    const direct = await host.setDirect({ hostname: "0.0.0.0", port: 0 })
    expect(direct?.port).toBeGreaterThan(0)
    const routes = await host.pairingRoutes({ directUrl: "ws://192.0.2.10:8787/ws" })
    expect(routes.map((route) => route.kind)).toEqual(["direct"])
    const offer = parsePairingOffer(routes[0]!.offer)
    expect(offer.transports.map((transport) => transport.kind)).toEqual(["lan"])

    await expect(host.setDirect({ hostname: "0.0.0.0", port: opencode.port! })).rejects.toThrow()
    expect(host.direct()?.port).toBe(direct?.port)
    expect((await fetch(`http://127.0.0.1:${direct?.port}/health`)).ok).toBe(true)

    await host.setDirect(null)
    expect(host.direct()).toBeUndefined()
    await expect(host.pairingRoutes()).rejects.toThrow(/no phone-reachable transport/u)
  })
})
