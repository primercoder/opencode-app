import { describe, expect, test } from "bun:test"
import {
  encodeRelayHostLink,
  encodeRelayInviteLink,
  parseRelayInviteLink,
  RELAY_HOST_PREFIX,
  RELAY_INVITE_PREFIX,
} from "../src/index.ts"

const rk = "A6LLjSRr4GQop2RuN35avG-Y8fKlBFsNiKy75hTAr3M"

describe("relay links", () => {
  test("host links are reusable and carry no invite", () => {
    const link = encodeRelayHostLink({ url: "ws://203.0.113.10:8443/ws", rk, relayId: "relay_demo" })
    expect(link.startsWith(RELAY_HOST_PREFIX)).toBe(true)
    const parsed = parseRelayInviteLink(link)
    expect(parsed).toMatchObject({ kind: "host", url: "ws://203.0.113.10:8443/ws", rk, relayId: "relay_demo" })
    expect(parsed.invite).toBeUndefined()
  })

  test("phone links still require a one-time invite", () => {
    const link = encodeRelayInviteLink({
      v: 3,
      kind: "client",
      url: "wss://relay.example/ws",
      rk,
      invite: "0123456789abcdef0123456789abcdef",
      relayId: "relay_demo",
    })
    expect(link.startsWith(RELAY_INVITE_PREFIX)).toBe(true)
    expect(parseRelayInviteLink(link).invite).toBe("0123456789abcdef0123456789abcdef")
  })

  test("host links reject phone invites and wrong prefixes", () => {
    expect(() => parseRelayInviteLink(`ocremote-relay://enroll#${btoa("{}")}`)).toThrow()
    expect(() => parseRelayInviteLink("ocremote://pair#abc")).toThrow()
  })
})
