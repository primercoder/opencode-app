import { sessionBusy, toMillis, type Page, type SessionInfo, type SessionMessage } from "@/opencode/client"

/**
 * Session sync helpers shared by the workspace. They are pure so gap-filling,
 * stale-busy and scroll-anchor rules can be tested without React Native.
 */

export const FINAL_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "interrupted", "error"])

export function isFinalOutcome(outcome: string | undefined): boolean {
  if (!outcome) return false
  return FINAL_OUTCOMES.has(outcome.toLowerCase())
}

/**
 * A session counts as running only while opencode says it is busy. Uses the
 * plain timestamp comparison from `sessionBusy`: the stored `outcome` lags
 * behind a new turn (opencode keeps the previous turn's outcome), so
 * consulting it here marked running sessions as idle.
 */
export function sessionRunning(session: SessionInfo | null | undefined): boolean {
  if (!session) return false
  return sessionBusy(session)
}

/** Merges authoritative pages by id and removes local optimistic echoes. */
export function mergeMessages(incoming: SessionMessage[], existing: SessionMessage[]): SessionMessage[] {
  const byId = new Map<string, SessionMessage>()
  for (const message of existing) {
    if (!message.id.startsWith("local_")) byId.set(message.id, message)
  }
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => toMillis(left.time?.created) - toMillis(right.time?.created))
}

export function messageIds(messages: SessionMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) ids.add(message.id)
  return ids
}

/**
 * True when the newest page does not overlap anything already loaded, which
 * means events were lost and older pages must be fetched to close the gap.
 */
export function pageLeavesGap(existing: SessionMessage[], page: SessionMessage[]): boolean {
  if (existing.length === 0 || page.length === 0) return false
  const known = messageIds(existing)
  return !page.some((message) => known.has(message.id))
}

/** How many older pages to walk when healing a gap. */
export const MAX_GAP_PAGES = 6

type Transcript = { messages: SessionMessage[]; olderCursor: string | undefined }

/**
 * Walk the OpenCode cursor chain until it reaches the cached transcript.
 * When the cache is too far behind, keep the contiguous server window and
 * its cursor so scrolling can still load every older message.
 */
export async function reconcileTranscript(
  fetchPage: (cursor?: string) => Promise<Page<SessionMessage>>,
  cached: Transcript,
): Promise<Transcript> {
  const existing = cached.messages.filter((message) => !message.id.startsWith("local_"))
  const known = messageIds(existing)
  const incoming: SessionMessage[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let index = 0; index <= MAX_GAP_PAGES; index += 1) {
    const page = await fetchPage(cursor)
    incoming.unshift(...[...page.data].reverse())
    if (page.data.some((message) => known.has(message.id))) {
      return { messages: mergeMessages(incoming, existing), olderCursor: cached.olderCursor }
    }
    cursor = page.cursor?.next
    if (!cursor || existing.length === 0 || page.data.length === 0) break
    if (cursors.has(cursor)) throw new Error("OpenCode returned a repeated message cursor")
    cursors.add(cursor)
  }
  return { messages: mergeMessages(incoming, []), olderCursor: cursor }
}

export type SessionRefreshKind = "session" | "message" | "permission" | "form" | "activity"

export function sessionRefreshKinds(type: string): SessionRefreshKind[] {
  if (type === "server.connected") return ["session", "message", "permission", "form", "activity"]
  if (type === "experimental.job.updated") return ["session", "activity"]
  if (type.startsWith("permission.")) return ["permission"]
  if (type.startsWith("form.")) return ["form"]
  if (type === "session.execution.started" || type.startsWith("session.inbox.")) return ["session", "message"]
  if (/^session\.execution\.|^session\.idle$|^(?:session\.)?shell\./u.test(type)) {
    return ["session", "message", "activity"]
  }
  if (/^(?:message\.|session\.(?:message|text|reasoning|tool|step|assistant|compaction|synthetic|skill\.activated)\b)/u.test(type)) {
    // These deltas are already rendered locally by SessionStreamController.
    return type.endsWith(".delta") || type === "session.step.streamed" ? [] : ["message"]
  }
  return type.startsWith("session.") ? ["session"] : []
}

/**
 * Whether the transcript should keep following new output. Only the very
 * bottom (inverted list offset near zero) follows; scrolling back pins the
 * visible content instead.
 */
export function shouldFollow(offset: number, threshold = 24): boolean {
  return offset <= threshold
}

/**
 * Compensates content growth that happens at the newest end of an inverted
 * list. Without this, a growing streamed message pushes the visible history
 * while the user is reading it.
 */
export function compensateOffset(input: {
  previousHeight: number
  nextHeight: number
  offset: number
  following: boolean
}): number | undefined {
  const delta = input.nextHeight - input.previousHeight
  if (input.following) return undefined
  // Growth at the newest end moves the anchor; shift the offset by the same
  // amount to keep the visible window stable. Shrinking needs no correction.
  if (delta <= 0.5) return undefined
  return input.offset + delta
}

/**
 * Kept as a pass-through: timestamps are trusted as-is. The previous
 * outcome-based "idle >= busy" normalization rewrote live sessions into an
 * idle state because opencode leaves the previous turn's outcome on the
 * session record while a new turn is running.
 */
export function normalizeSession(session: SessionInfo): SessionInfo {
  return session
}
