import AsyncStorage from "@react-native-async-storage/async-storage"
import * as SecureStore from "expo-secure-store"
import { base64UrlEncode } from "@ocremote/protocol"

export type RelayAccess = {
  subjectId: string
  secret: string
  /** Relay X25519 public key pinned by the invite. */
  relayKey: string
  room?: string
  name?: string
  relayId?: string
  createdAt: number
}

export type RelayAccessSummary = Omit<RelayAccess, "secret"> & { url: string }

const INDEX_KEY = "ocremote.relayAccess.v1"
const ITEM_PREFIX = "ocremote.relay."

/** Relay identity is keyed by origin + path, ignoring query and hash. */
export function normalizeRelayUrl(input: string): string {
  const url = new URL(input)
  url.search = ""
  url.hash = ""
  return url.toString()
}

export async function loadRelayAccess(url: string): Promise<RelayAccess | undefined> {
  const raw = await SecureStore.getItemAsync(itemKey(url))
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.subjectId !== "string" || typeof parsed.secret !== "string") return undefined
    return {
      subjectId: parsed.subjectId,
      secret: parsed.secret,
      relayKey: typeof parsed.relayKey === "string" ? parsed.relayKey : "",
      ...(typeof parsed.room === "string" ? { room: parsed.room } : {}),
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.relayId === "string" ? { relayId: parsed.relayId } : {}),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    }
  } catch {
    return undefined
  }
}

export async function saveRelayAccess(url: string, access: RelayAccess): Promise<void> {
  const normalized = normalizeRelayUrl(url)
  await SecureStore.setItemAsync(itemKey(normalized), JSON.stringify(access), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
  const index = await loadIndex()
  const summary: RelayAccessSummary = {
    url: normalized,
    subjectId: access.subjectId,
    relayKey: access.relayKey,
    ...(access.room ? { room: access.room } : {}),
    ...(access.name ? { name: access.name } : {}),
    ...(access.relayId ? { relayId: access.relayId } : {}),
    createdAt: access.createdAt,
  }
  const next = index.filter((item) => item.url !== normalized)
  next.push(summary)
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(next))
}

export async function removeRelayAccess(url: string): Promise<void> {
  const normalized = normalizeRelayUrl(url)
  await SecureStore.deleteItemAsync(itemKey(normalized))
  const index = await loadIndex()
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index.filter((item) => item.url !== normalized)))
}

export async function listRelayAccess(): Promise<RelayAccessSummary[]> {
  return loadIndex()
}

async function loadIndex(): Promise<RelayAccessSummary[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSummary)
  } catch {
    return []
  }
}

function itemKey(url: string): string {
  return ITEM_PREFIX + base64UrlEncode(new TextEncoder().encode(normalizeRelayUrl(url)))
}

function isSummary(value: unknown): value is RelayAccessSummary {
  return isRecord(value) && typeof value.url === "string" && typeof value.subjectId === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
