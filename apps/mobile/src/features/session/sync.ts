import { toMillis, type SessionInfo, type SessionMessage } from "@/opencode/client"

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
 * A session counts as running only while opencode says it is busy *and* the
 * turn has no final outcome. A missed or reordered event used to leave the
 * header, activity pill and stop button stuck forever because only the busy
 * timestamps were consulted.
 */
export function sessionRunning(session: SessionInfo | null | undefined): boolean {
  if (!session) return false
  if (isFinalOutcome(session.outcome)) return false
  const busy = toMillis(session.time?.busy)
  const idle = toMillis(session.time?.idle)
  return busy > 0 && busy >= idle
}

/** Merges pages by id, keeping local optimistic messages until they arrive. */
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

/** Sessions whose final outcome arrived but timestamps still look busy. */
export function normalizeSession(session: SessionInfo): SessionInfo {
  if (!isFinalOutcome(session.outcome)) return session
  const time = session.time
  if (!time) return session
  const busy = toMillis(time.busy)
  const idle = toMillis(time.idle)
  if (!(busy > idle)) return session
  return { ...session, time: { ...time, idle: Math.max(idle, busy) } }
}
