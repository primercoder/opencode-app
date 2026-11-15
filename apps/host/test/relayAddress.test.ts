import { afterEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_RELAY_ADDRESS,
  DEFAULT_RELAY_URL,
  parseRelayAddress,
  resolveRelayProfile,
} from "../src/relay.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe("relay addresses", () => {
  test("uses the cloud relay by default", () => {
    expect(parseRelayAddress("")).toMatchObject({
      url: DEFAULT_RELAY_URL,
      host: "118.31.124.193",
      port: 8443,
      tls: false,
    })
    expect(DEFAULT_RELAY_ADDRESS).toBe("118.31.124.193:8443")
  })

  test("accepts ip:port and ws URLs", () => {
    expect(parseRelayAddress("203.0.113.10:9443")).toMatchObject({
      url: "ws://203.0.113.10:9443/ws",
      port: 9443,
    })
    expect(parseRelayAddress("wss://relay.example/ws")).toMatchObject({
      url: "wss://relay.example/ws",
      port: 443,
      tls: true,
    })
  })

  test("fetches and pins the relay key from /v1/info", async () => {
    let hits = 0
    let serverPort = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        hits += 1
        if (new URL(request.url).pathname !== "/v1/info") return new Response("not found", { status: 404 })
        return Response.json({
          relayId: "relay_test",
          wsUrl: `ws://127.0.0.1:${serverPort}/ws`,
          relayPublicKey: "A6LLjSRr4GQop2RuN35avG-Y8fKlBFsNiKy75hTAr3M",
        })
      },
    })
    serverPort = server.port ?? 0
    cleanups.push(() => server.stop(true))
    const address = `127.0.0.1:${serverPort}`
    const first = await resolveRelayProfile({ address })
    expect(first).toMatchObject({
      relayId: "relay_test",
      relayKey: "A6LLjSRr4GQop2RuN35avG-Y8fKlBFsNiKy75hTAr3M",
    })
    expect(hits).toBe(1)

    const saved = {
      url: first.url,
      room: "room_test",
      subjectId: "sub_test",
      secret: "secret",
      relayKey: first.relayKey,
      enabled: true,
    }
    await resolveRelayProfile({ address, saved })
    expect(hits).toBe(1)

    let changedPort = 0
    const changed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(): Response {
        return Response.json({
          relayId: "relay_test",
          wsUrl: `ws://127.0.0.1:${changedPort}/ws`,
          relayPublicKey: "B6LLjSRr4GQop2RuN35avG-Y8fKlBFsNiKy75hTAr3M",
        })
      },
    })
    changedPort = changed.port ?? 0
    cleanups.push(() => changed.stop(true))
    const changedSaved = { ...saved, url: `ws://127.0.0.1:${changedPort}/ws` }
    await expect(
      resolveRelayProfile({ address: `127.0.0.1:${changedPort}`, saved: changedSaved, probe: true }),
    ).rejects.toThrow(/identity changed/u)
    const refreshed = await resolveRelayProfile({
      address: `127.0.0.1:${changedPort}`,
      saved: changedSaved,
      probe: true,
      refreshKey: true,
    })
    expect(refreshed.relayKey).toBe("B6LLjSRr4GQop2RuN35avG-Y8fKlBFsNiKy75hTAr3M")
  })
})
