import { describe, expect, test } from "bun:test"
import type { Transport } from "@ocremote/protocol"
import { mergeTransports, normalizeTransports, replaceTransport } from "../src/lib/transports.ts"

const direct = (url = "ws://192.168.1.10:8787/ws"): Transport => ({ kind: "lan", url, priority: 0 })
const relay = (room = "room_a"): Transport => ({
  kind: "relay",
  url: "ws://relay.example/ws",
  room,
  relayKey: "A6LLjSRr4GQop2RuN35avG-Y8fKlBFsNiKy75hTAr3M",
  priority: 1,
})

describe("mobile transport routes", () => {
  test("keeps one direct and one relay route", () => {
    expect(normalizeTransports([direct(), direct("ws://192.168.1.11:8787/ws"), relay()]).map((route) => route.kind)).toEqual([
      "lan",
      "relay",
    ])
  })

  test("re-adding a kind replaces it instead of appending", () => {
    const routes = replaceTransport([direct(), relay()], relay("room_b"))
    expect(routes).toHaveLength(2)
    expect(routes[1]).toMatchObject({ kind: "relay", room: "room_b" })
  })

  test("pairing merge does not drop the other route", () => {
    const merged = mergeTransports([relay()], [direct("ws://192.168.1.12:8787/ws")])
    expect(merged.map((route) => route.kind)).toEqual(["lan", "relay"])
  })

  test("a relay route removes a legacy loopback direct route", () => {
    expect(normalizeTransports([direct("ws://127.0.0.1:8787/ws"), relay()]).map((route) => route.kind)).toEqual(["relay"])
  })
})
