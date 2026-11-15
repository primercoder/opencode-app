import AsyncStorage from "@react-native-async-storage/async-storage"
import * as SecureStore from "expo-secure-store"
import type { Transport } from "@ocremote/protocol"
import { normalizeTransports } from "@/lib/transports"

export type HostRecord = {
  id: string
  name: string
  publicKey: string
  fingerprint: string
  transports: Transport[]
  lastConnectedAt?: number
  lastTransport?: string
}

export type HostCredentials = {
  deviceId: string
  token: string
}

const HOSTS_KEY = "ocremote.hosts.v1"
const TOKEN_PREFIX = "ocremote.device."

export async function loadHosts(): Promise<HostRecord[]> {
  const raw = await AsyncStorage.getItem(HOSTS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isHostRecord).map((host) => ({
      ...host,
      transports: normalizeTransports(host.transports),
    }))
  } catch {
    return []
  }
}

export async function saveHosts(hosts: HostRecord[]): Promise<void> {
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts))
}

export async function loadCredentials(hostId: string): Promise<HostCredentials | undefined> {
  const raw = await SecureStore.getItemAsync(tokenKey(hostId))
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.deviceId !== "string" || typeof parsed.token !== "string") return undefined
    return { deviceId: parsed.deviceId, token: parsed.token }
  } catch {
    return undefined
  }
}

export async function saveCredentials(hostId: string, credentials: HostCredentials): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(hostId), JSON.stringify(credentials), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function removeCredentials(hostId: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(hostId))
}

function tokenKey(hostId: string): string {
  return `${TOKEN_PREFIX}${hostId.replace(/[^A-Za-z0-9._-]/gu, "_")}`
}

function isHostRecord(value: unknown): value is HostRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.publicKey === "string" &&
    typeof value.fingerprint === "string" &&
    Array.isArray(value.transports)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
