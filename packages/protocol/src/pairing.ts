import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { z } from "zod"

const wsUrl = z.string().regex(/^wss?:\/\/\S+$/u, "expected a ws:// or wss:// URL")

export const LanTransportSchema = z.object({
  kind: z.literal("lan"),
  url: wsUrl,
  priority: z.number().int().nonnegative(),
})

export const RelayTransportSchema = z.object({
  kind: z.literal("relay"),
  url: wsUrl,
  room: z.string().min(1),
  clientToken: z.string().min(1),
  priority: z.number().int().nonnegative(),
})

export const CustomTransportSchema = z.object({
  kind: z.literal("custom"),
  url: wsUrl,
  priority: z.number().int().nonnegative(),
  headers: z.record(z.string(), z.string()).optional(),
})

export const TransportSchema = z.discriminatedUnion("kind", [
  LanTransportSchema,
  RelayTransportSchema,
  CustomTransportSchema,
])

export type Transport = z.infer<typeof TransportSchema>

export const PairingOfferSchema = z.object({
  v: z.literal(1),
  hostId: z.string().min(1),
  name: z.string().min(1),
  pk: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/u),
  pairCode: z.string().min(1),
  expiresAt: z.number().int().positive(),
  transports: z.array(TransportSchema).min(1),
})

export type PairingOffer = z.infer<typeof PairingOfferSchema>

export function fingerprintOfPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey).slice(0, 8))
}

// Pure TypeScript base64url: Hermes does not reliably expose btoa/atob.
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const BASE64_VALUES = new Map<string, number>(
  Array.from(BASE64_ALPHABET, (character, index) => [character, index] as const),
)

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    out += BASE64_ALPHABET[first >> 2]
    out += BASE64_ALPHABET[((first & 0x03) << 4) | (second === undefined ? 0 : second >> 4)]
    if (second === undefined) break
    out += BASE64_ALPHABET[((second & 0x0f) << 2) | (third === undefined ? 0 : third >> 6)]
    if (third === undefined) break
    out += BASE64_ALPHABET[third & 0x3f]
  }
  return out
}

export function base64UrlDecode(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new Error("invalid base64url length")
  const values: number[] = []
  for (const character of value) {
    const decoded = BASE64_VALUES.get(character)
    if (decoded === undefined) throw new Error("invalid base64url character")
    values.push(decoded)
  }

  const out = new Uint8Array(Math.floor((values.length * 3) / 4))
  let offset = 0
  for (let index = 0; index < values.length; index += 4) {
    const first = values[index] ?? 0
    const second = values[index + 1]
    const third = values[index + 2]
    const fourth = values[index + 3]
    if (second === undefined) throw new Error("invalid base64url length")
    out[offset++] = (first << 2) | (second >> 4)
    if (third === undefined) break
    out[offset++] = ((second & 0x0f) << 4) | (third >> 2)
    if (fourth === undefined) break
    out[offset++] = ((third & 0x03) << 6) | fourth
  }
  return out
}

export function encodePairingOffer(input: PairingOffer, publicKey: Uint8Array): string {
  const offer = PairingOfferSchema.parse({
    ...input,
    pk: base64UrlEncode(publicKey),
    fingerprint: fingerprintOfPublicKey(publicKey),
  })
  return `ocremote://pair#${base64UrlEncode(new TextEncoder().encode(JSON.stringify(offer)))}`
}

export function parsePairingOffer(input: string): PairingOffer {
  const trimmed = input.trim()
  const hash = trimmed.indexOf("#")
  if (hash === -1) throw new Error("pairing offer is missing its fragment")
  const encoded = trimmed.slice(hash + 1)
  if (!encoded) throw new Error("pairing offer fragment is empty")

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)))
  } catch {
    throw new Error("pairing offer payload is not valid base64url JSON")
  }

  return PairingOfferSchema.parse(parsed)
}

export function isPairingOfferExpired(offer: PairingOffer, now = Date.now()): boolean {
  return offer.expiresAt <= now
}
