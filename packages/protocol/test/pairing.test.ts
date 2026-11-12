import { describe, expect, test } from "bun:test"
import {
  base64UrlDecode,
  base64UrlEncode,
  encodePairingOffer,
  fingerprintOfPublicKey,
  isPairingOfferExpired,
  parsePairingOffer,
  type PairingOffer,
} from "../src/pairing.ts"

const publicKey = new Uint8Array(32).fill(7)

function offer(overrides: Partial<PairingOffer> = {}): PairingOffer {
  return {
    v: 1,
    hostId: "host_test",
    name: "Test Host",
    pk: "",
    fingerprint: fingerprintOfPublicKey(publicKey),
    pairCode: "K7Q9-M2X4",
    expiresAt: 1_800_000_000_000,
    transports: [{ kind: "lan", url: "ws://192.168.1.10:8787/ws", priority: 0 }],
    ...overrides,
  }
}

describe("base64url", () => {
  test("round-trips arbitrary bytes without padding", () => {
    const bytes = new Uint8Array([0, 255, 254, 251, 239, 190, 1, 2, 3])
    const encoded = base64UrlEncode(bytes)

    expect(encoded).not.toMatch(/[+/=]/u)
    expect(base64UrlDecode(encoded)).toEqual(bytes)
  })

  test("rejects invalid characters", () => {
    expect(() => base64UrlDecode("ab$c")).toThrow()
  })
})

describe("pairing offers", () => {
  test("encodes and parses a URL fragment", () => {
    const input = offer()
    const url = encodePairingOffer(input, publicKey)

    expect(url.startsWith("ocremote://pair#")).toBe(true)
    expect(parsePairingOffer(url)).toEqual({
      ...input,
      pk: expect.any(String),
    })
  })

  test("includes the public key in the offer", () => {
    const parsed = parsePairingOffer(encodePairingOffer(offer(), publicKey))
    expect(parsed.pk).toHaveLength(43)
    expect(parsed.fingerprint).toBe(fingerprintOfPublicKey(publicKey))
  })

  test("rejects a missing fragment", () => {
    expect(() => parsePairingOffer("ocremote://pair")).toThrow()
  })

  test("rejects malformed payloads", () => {
    expect(() => parsePairingOffer("ocremote://pair#not-json")).toThrow()
  })

  test("reports expiry", () => {
    expect(isPairingOfferExpired(offer({ expiresAt: 1_000 }), 1_001)).toBe(true)
    expect(isPairingOfferExpired(offer({ expiresAt: 1_000 }), 999)).toBe(false)
  })

  test("computes a stable fingerprint", () => {
    expect(fingerprintOfPublicKey(publicKey)).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprintOfPublicKey(publicKey)).toBe(fingerprintOfPublicKey(publicKey))
  })
})
