import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { base64UrlEncode } from "@ocremote/protocol"
import type { Device, DeviceScope, HostConfig, PendingPair } from "./config.ts"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const PAIR_CODE_BYTES = 5
const PAIR_CODE_TTL_MS = 5 * 60_000
const MAX_PENDING_PAIRS = 8
const MAX_DEVICES = 16

export function generatePairCode(): string {
  const bytes = randomBytes(PAIR_CODE_BYTES)
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(value >>> bits) & 31]
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  const code = out.slice(0, 8)
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function normalizePairCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/gu, "")
}

export function hashPairCode(code: string): string {
  return createHash("sha256").update(normalizePairCode(code)).digest("hex")
}

export function addPendingPair(
  config: HostConfig,
  scope: DeviceScope,
  ttlMs = PAIR_CODE_TTL_MS,
  now = Date.now(),
): { code: string; pending: PendingPair } {
  config.pendingPairs = config.pendingPairs.filter((pair) => pair.expiresAt > now).slice(-(MAX_PENDING_PAIRS - 1))
  const code = generatePairCode()
  const pending: PendingPair = { codeHash: hashPairCode(code), expiresAt: now + ttlMs, scope }
  config.pendingPairs.push(pending)
  return { code, pending }
}

export function consumePendingPair(config: HostConfig, code: string, now = Date.now()): DeviceScope | null {
  const hash = hashPairCode(code)
  const index = config.pendingPairs.findIndex((pair) => pair.codeHash === hash && pair.expiresAt > now)
  if (index === -1) return null
  const [pending] = config.pendingPairs.splice(index, 1)
  return pending?.scope ?? null
}

export function createDevice(input: {
  name: string
  platform: string
  scope: DeviceScope
  now?: number
}): { device: Device; token: string } {
  const token = base64UrlEncode(randomBytes(32))
  const now = input.now ?? Date.now()
  return {
    token,
    device: {
      id: `dev_${randomBytes(6).toString("hex")}`,
      name: input.name,
      platform: input.platform,
      scope: input.scope,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
    },
  }
}

export function addDevice(config: HostConfig, device: Device): void {
  config.devices = config.devices.filter((item) => item.id !== device.id && !item.revokedAt).slice(-(MAX_DEVICES - 1))
  config.devices.push(device)
}

export function findDevice(config: HostConfig, deviceId: string): Device | undefined {
  return config.devices.find((device) => device.id === deviceId && !device.revokedAt)
}

export function verifyDeviceToken(device: Device, token: string): boolean {
  const expected = Buffer.from(device.tokenHash, "hex")
  const actual = Buffer.from(hashToken(token), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function revokeDevice(config: HostConfig, deviceId: string, now = Date.now()): boolean {
  const device = config.devices.find((item) => item.id === deviceId)
  if (!device || device.revokedAt) return false
  device.revokedAt = now
  return true
}

export function isMethodAllowed(scope: DeviceScope, method: string): boolean {
  if (scope === "full") return true
  return method === "GET" || method === "HEAD"
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
