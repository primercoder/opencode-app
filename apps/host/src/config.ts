import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { base64UrlDecode, base64UrlEncode, fingerprintOfPublicKey, generateNoiseKeyPair } from "@ocremote/protocol"

export type DeviceScope = "full" | "read"

export type Device = {
  id: string
  name: string
  platform: string
  scope: DeviceScope
  tokenHash: string
  createdAt: number
  lastSeenAt?: number
  revokedAt?: number
}

export type PendingPair = {
  codeHash: string
  expiresAt: number
  scope: DeviceScope
}

export type RelayConfig = {
  url: string
  room: string
  /** Long-lived relay subject returned by the relay. */
  subjectId: string
  secret: string
  /** Relay X25519 public key pinned from /v1/info. */
  relayKey: string
  relayId?: string
  /** Kept so "relay off"/"relay on" can reuse the same relay identity. */
  enabled?: boolean
}

export type DirectConfig = {
  hostname: string
  port: number
}

export type HostConfig = {
  v: 2
  hostId: string
  name: string
  /** Present only when direct/LAN access is enabled. */
  direct?: DirectConfig
  relay?: RelayConfig
  opencode?: {
    url: string
    password: string
  }
  devices: Device[]
  pendingPairs: PendingPair[]
}

export type Identity = {
  v: 1
  hostId: string
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function resolveHome(override?: string): string {
  return override ?? process.env.OCREMOTE_HOME ?? join(homedir(), ".config", "ocremote")
}

export function defaultHostName(): string {
  return process.env.OCREMOTE_HOST_NAME ?? process.env.HOSTNAME ?? "ocremote-host"
}

export async function loadOrCreateIdentity(home: string, hostName = defaultHostName()): Promise<Identity> {
  const path = join(home, "identity.json")
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      v?: number
      hostId?: string
      publicKey?: string
      secretKey?: string
    }
    if (raw.v !== 1 || !raw.hostId || !raw.publicKey || !raw.secretKey) throw new Error("invalid identity")
    const publicKey = base64UrlDecode(raw.publicKey)
    const secretKey = base64UrlDecode(raw.secretKey)
    if (publicKey.byteLength !== 32 || secretKey.byteLength !== 32) throw new Error("invalid identity key length")
    return { v: 1, hostId: raw.hostId, publicKey, secretKey }
  } catch {
    const keyPair = generateNoiseKeyPair()
    const identity: Identity = {
      v: 1,
      hostId: `host_${randomBytes(6).toString("hex")}`,
      publicKey: keyPair.publicKey,
      secretKey: keyPair.secretKey,
    }
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(
      path,
      JSON.stringify(
        {
          v: identity.v,
          hostId: identity.hostId,
          publicKey: base64UrlEncode(identity.publicKey),
          secretKey: base64UrlEncode(identity.secretKey),
          name: hostName,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
    return identity
  }
}

export async function loadConfig(
  home: string,
  defaults: { hostId: string; name: string; direct?: DirectConfig },
): Promise<HostConfig> {
  const path = join(home, "config.json")
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<HostConfig> & {
      lan?: DirectConfig
    }
    const migrated =
      raw.direct ??
      (raw.lan && !isLoopbackHostname(raw.lan.hostname) ? raw.lan : undefined)
    const rawRelay = raw.relay as (RelayConfig & { clientInvite?: string }) | undefined
    const relay: RelayConfig | undefined = rawRelay
      ? {
          url: rawRelay.url,
          room: rawRelay.room,
          subjectId: rawRelay.subjectId,
          secret: rawRelay.secret,
          relayKey: rawRelay.relayKey,
          ...(rawRelay.relayId ? { relayId: rawRelay.relayId } : {}),
          ...(rawRelay.enabled === false ? { enabled: false } : {}),
        }
      : undefined
    return {
      v: 2,
      hostId: raw.hostId || defaults.hostId,
      name: raw.name || defaults.name,
      ...(migrated ? { direct: migrated } : defaults.direct ? { direct: defaults.direct } : {}),
      ...(raw.opencode ? { opencode: raw.opencode } : {}),
      ...(relay ? { relay } : {}),
      devices: Array.isArray(raw.devices) ? raw.devices : [],
      pendingPairs: Array.isArray(raw.pendingPairs) ? raw.pendingPairs : [],
    }
  } catch {
    const config: HostConfig = {
      v: 2,
      hostId: defaults.hostId,
      name: defaults.name,
      ...(defaults.direct ? { direct: defaults.direct } : {}),
      devices: [],
      pendingPairs: [],
    }
    await saveConfig(home, config)
    return config
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
}

export async function saveConfig(home: string, config: HostConfig): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
}

export function fingerprint(identity: Identity): string {
  return fingerprintOfPublicKey(identity.publicKey)
}
