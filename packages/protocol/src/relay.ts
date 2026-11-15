import { z } from "zod"
import { base64UrlDecode, base64UrlEncode } from "./pairing.ts"

export const RELAY_INVITE_PREFIX = "ocremote-relay://enroll#"
export const RELAY_HOST_PREFIX = "ocremote-relay://host#"

const wsUrl = z.string().regex(/^wss?:\/\/\S+$/u, "expected a ws:// or wss:// URL")

export const RelayInviteSchema = z
  .object({
    v: z.literal(3),
    kind: z.enum(["host", "client"]),
    url: wsUrl,
    /** One-time enrollment token. Host links carry no token. */
    invite: z.string().min(16).optional(),
    /** Relay static X25519 public key, pinned by the link. */
    rk: z.string().min(32),
    relayId: z.string().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === "client" && !value.invite) {
      context.addIssue({ code: "custom", message: "phone relay links require an invite", path: ["invite"] })
    }
    if (value.kind === "host" && value.invite && value.invite.length < 16) {
      context.addIssue({ code: "custom", message: "host invite is too short", path: ["invite"] })
    }
  })

export type RelayInvite = z.infer<typeof RelayInviteSchema>

/** Decode a reusable host link or a one-time relay enrollment link. */
export function parseRelayInviteLink(input: string): RelayInvite {
  const trimmed = input.trim()
  const prefix = trimmed.startsWith(RELAY_HOST_PREFIX)
    ? RELAY_HOST_PREFIX
    : trimmed.startsWith(RELAY_INVITE_PREFIX)
      ? RELAY_INVITE_PREFIX
      : ""
  if (!prefix) {
    throw new Error(`relay link must start with ${RELAY_HOST_PREFIX} or ${RELAY_INVITE_PREFIX}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(trimmed.slice(prefix.length))))
  } catch {
    throw new Error("relay link payload is not valid base64url JSON")
  }
  const result = RelayInviteSchema.safeParse(parsed)
  if (!result.success) throw new Error("relay link payload is invalid")
  if (prefix === RELAY_HOST_PREFIX && (result.data.kind !== "host" || result.data.invite)) {
    throw new Error("relay host link is not valid")
  }
  if (prefix === RELAY_INVITE_PREFIX && !result.data.invite) {
    throw new Error("relay enrollment link is missing its invite")
  }
  return result.data
}

export function encodeRelayInviteLink(invite: RelayInvite): string {
  const value = RelayInviteSchema.parse(invite)
  const prefix = value.kind === "host" && !value.invite ? RELAY_HOST_PREFIX : RELAY_INVITE_PREFIX
  return prefix + base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

export function encodeRelayHostLink(link: {
  url: string
  rk: string
  relayId?: string
}): string {
  return encodeRelayInviteLink({ v: 3, kind: "host", url: link.url, rk: link.rk, ...(link.relayId ? { relayId: link.relayId } : {}) })
}
