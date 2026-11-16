import { useSyncExternalStore } from "react"

const MAX_DRAFTS = 64
const drafts = new Map<string, string>()
const listeners = new Set<() => void>()

function key(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function readSessionDraft(hostId: string, sessionId: string): string {
  return drafts.get(key(hostId, sessionId)) ?? ""
}

export function writeSessionDraft(hostId: string, sessionId: string, text: string): void {
  const cacheKey = key(hostId, sessionId)
  if (drafts.get(cacheKey) === text) return
  drafts.delete(cacheKey)
  if (text.length > 0) {
    drafts.set(cacheKey, text)
    while (drafts.size > MAX_DRAFTS) {
      const oldest = drafts.keys().next().value
      if (oldest === undefined) break
      drafts.delete(oldest)
    }
  }
  emit()
}

export function clearSessionDraft(hostId: string, sessionId: string): void {
  writeSessionDraft(hostId, sessionId, "")
}

/** Composer text for one session; switching sessions swaps drafts instantly. */
export function useSessionDraft(hostId: string, sessionId: string | undefined): string {
  return useSyncExternalStore(subscribe, () => (sessionId ? readSessionDraft(hostId, sessionId) : ""))
}
