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

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
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
