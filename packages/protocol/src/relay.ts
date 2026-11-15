import { z } from "zod"
import { base64UrlDecode, base64UrlEncode } from "./pairing.ts"

export const RELAY_INVITE_PREFIX = "ocremote-relay://enroll#"

const wsUrl = z.string().regex(/^wss?:\/\/\S+$/u, "expected a ws:// or wss:// URL")

export const RelayInviteSchema = z.object({
  v: z.literal(3),
  kind: z.enum(["host", "client"]),
  url: wsUrl,
  invite: z.string().min(16),
  /** Relay static X25519 public key, pinned by the invite. */
  rk: z.string().min(32),
  relayId: z.string().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
})

export type RelayInvite = z.infer<typeof RelayInviteSchema>

/** Decode the self-contained one-time relay enrollment link. */
export function parseRelayInviteLink(input: string): RelayInvite {
  const trimmed = input.trim()
  if (!trimmed.startsWith(RELAY_INVITE_PREFIX)) {
    throw new Error(`relay invite must start with ${RELAY_INVITE_PREFIX}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(trimmed.slice(RELAY_INVITE_PREFIX.length))))
  } catch {
    throw new Error("relay invite payload is not valid base64url JSON")
  }
  const result = RelayInviteSchema.safeParse(parsed)
  if (!result.success) throw new Error("relay invite payload is invalid")
  return result.data
}

export function encodeRelayInviteLink(invite: RelayInvite): string {
  const value = RelayInviteSchema.parse(invite)
  return RELAY_INVITE_PREFIX + base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}
