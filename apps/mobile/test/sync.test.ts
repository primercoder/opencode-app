import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessage } from "../src/opencode/client.ts"
import {
  compensateOffset,
  isFinalOutcome,
  MAX_GAP_PAGES,
  mergeMessages,
  messageIds,
  normalizeSession,
  pageLeavesGap,
  reconcileTranscript,
  sessionRefreshKinds,
  sessionRunning,
  shouldFollow,
} from "../src/features/session/sync.ts"

const message = (id: string, created = 1): SessionMessage => ({ id, type: "user", text: id, time: { created } })

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id: "ses_a", ...overrides } as SessionInfo
}

describe("session running state", () => {
  test("busy without a final outcome counts as running", () => {
    expect(sessionRunning(session({ time: { busy: 200, idle: 100 } }))).toBe(true)
  })

  test("idle after busy is not running", () => {
    expect(sessionRunning(session({ time: { busy: 100, idle: 200 } }))).toBe(false)
  })

  test("a stored outcome does not mask a running turn", () => {
    // opencode keeps the previous turn's outcome ("succeeded") on the session
    // while a new turn is running, so timestamps alone decide.
    for (const outcome of ["succeeded", "failed", "cancelled", "interrupted", "SUCCEEDED"]) {
      const value = session({ outcome, time: { busy: 500, idle: 100 } })
      expect(sessionRunning(value)).toBe(true)
      expect(isFinalOutcome(value.outcome)).toBe(true)
    }
    // Once idle is newer than busy the session really is finished.
    for (const outcome of ["succeeded", "failed", "cancelled"]) {
      const value = session({ outcome, time: { busy: 100, idle: 500 } })
      expect(sessionRunning(value)).toBe(false)
    }
  })

  test("an in-progress outcome still obeys the busy timestamps", () => {
    expect(sessionRunning(session({ outcome: "running", time: { busy: 500, idle: 100 } }))).toBe(true)
    expect(sessionRunning(session({ outcome: "running", time: { busy: 100, idle: 500 } }))).toBe(false)
  })

  test("normalizeSession keeps timestamps untouched", () => {
    const value = session({ outcome: "succeeded", time: { busy: 500, idle: 100 } })
    expect(normalizeSession(value)).toBe(value)
  })
})

describe("message gap detection", () => {
  test("a page that overlaps the transcript is not a gap", () => {
    const existing = [message("m1"), message("m2"), message("m3")]
    const page = [message("m2"), message("m3"), message("m4")]
    expect(pageLeavesGap(existing, page)).toBe(false)
  })

  test("a page sharing no id with the transcript is a gap", () => {
    const existing = [message("m1"), message("m2")]
    const page = [message("m9"), message("m10")]
    expect(pageLeavesGap(existing, page)).toBe(true)
  })

  test("an empty transcript or empty page never reports a gap", () => {
    expect(pageLeavesGap([], [message("m1")])).toBe(false)
    expect(pageLeavesGap([message("m1")], [])).toBe(false)
  })

  test("mergeMessages keeps order, replaces updates and drops local echoes", () => {
    const merged = mergeMessages(
      [message("m2", 20), message("m3", 30)],
      [message("local_1", 5), message("m1", 10), message("m2", 20)],
    )
    expect(merged.map((item) => item.id)).toEqual(["m1", "m2", "m3"])
    expect(messageIds(merged)).toEqual(new Set(["m1", "m2", "m3"]))
  })

  test("gap healing is bounded", () => {
    expect(MAX_GAP_PAGES).toBeGreaterThan(0)
    expect(MAX_GAP_PAGES).toBeLessThanOrEqual(10)
  })

  test("walks a short page's cursor to fill a reconnect gap", async () => {
    const cached = { messages: [message("m1", 1), message("m2", 2)], olderCursor: "cached-older" }
    const result = await reconcileTranscript(async (cursor) => {
      if (cursor === "older") return { data: [message("m3", 3), message("m2", 2)] }
      return { data: [message("m4", 4)], cursor: { next: "older" } }
    }, cached)
    expect(result.messages.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"])
    expect(result.olderCursor).toBe("cached-older")
  })

  test("keeps an older cursor and a continuous window when the cache is too far behind", async () => {
    const newest = 100
    const result = await reconcileTranscript(async (cursor) => {
      const number = cursor ? Number(cursor) : newest
      return { data: [message(`m${number}`, number)], cursor: { next: String(number - 1) } }
    }, { messages: [message("m1")], olderCursor: "stale" })
    expect(result.messages.map((item) => item.id)).toEqual(
      Array.from({ length: MAX_GAP_PAGES + 1 }, (_, index) => `m${newest - MAX_GAP_PAGES + index}`),
    )
    expect(result.olderCursor).toBe(String(newest - MAX_GAP_PAGES - 1))
  })

  test("reports a failed gap fetch instead of publishing separated pages", async () => {
    const cached = { messages: [message("m1")], olderCursor: undefined }
    await expect(reconcileTranscript(async (cursor) => {
      if (cursor) throw new Error("network interruption")
      return { data: [message("m9")], cursor: { next: "older" } }
    }, cached)).rejects.toThrow("network interruption")
    expect(cached.messages.map((item) => item.id)).toEqual(["m1"])
  })

  test("reconciles shell and interruption events without polling for every token", () => {
    expect(sessionRefreshKinds("session.text.delta")).toEqual([])
    expect(sessionRefreshKinds("session.reasoning.delta")).toEqual([])
    expect(sessionRefreshKinds("session.shell.ended")).toEqual(["session", "message", "activity"])
    expect(sessionRefreshKinds("session.execution.interrupted")).toEqual(["session", "message", "activity"])
    expect(sessionRefreshKinds("experimental.job.updated")).toEqual(["session", "activity"])
  })
})

describe("scroll following", () => {
  test("follows only near the bottom of an inverted list", () => {
    expect(shouldFollow(0)).toBe(true)
    expect(shouldFollow(12)).toBe(true)
    expect(shouldFollow(240)).toBe(false)
  })

  test("growth while reading history shifts the offset by the same amount", () => {
    expect(compensateOffset({ previousHeight: 1000, nextHeight: 1300, offset: 500, following: false })).toBe(800)
  })

  test("never compensates while following or when content shrinks", () => {
    expect(compensateOffset({ previousHeight: 1000, nextHeight: 1300, offset: 500, following: true })).toBeUndefined()
    expect(compensateOffset({ previousHeight: 1000, nextHeight: 900, offset: 500, following: false })).toBeUndefined()
  })
})
