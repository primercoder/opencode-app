import type {
  FormInfo,
  InboxItem,
  PermissionRequest,
  SessionInfo,
  SessionMessage,
} from "@/opencode/client"

export type SessionSnapshot = {
  session: SessionInfo
  messages: SessionMessage[]
  olderCursor?: string
  inbox: InboxItem[]
  children: SessionInfo[]
  permissions: PermissionRequest[]
  forms: FormInfo[]
  offset: number
  updatedAt: number
}

const MAX_SESSIONS = 16
const cache = new Map<string, SessionSnapshot>()

function key(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`
}

export function readSessionCache(hostId: string, sessionId: string): SessionSnapshot | undefined {
  return cache.get(key(hostId, sessionId))
}

export function writeSessionCache(
  hostId: string,
  sessionId: string,
  snapshot: Omit<SessionSnapshot, "updatedAt">,
): void {
  const cacheKey = key(hostId, sessionId)
  cache.delete(cacheKey)
  cache.set(cacheKey, { ...snapshot, updatedAt: Date.now() })
  while (cache.size > MAX_SESSIONS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function updateSessionOffset(hostId: string, sessionId: string, offset: number): void {
  const cached = cache.get(key(hostId, sessionId))
  if (cached) cached.offset = offset
}

export function deleteSessionCache(hostId: string, sessionId: string): void {
  cache.delete(key(hostId, sessionId))
}
