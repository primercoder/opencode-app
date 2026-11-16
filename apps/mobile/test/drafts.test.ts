import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearSessionDraft,
  readSessionDraft,
  writeSessionDraft,
} from "../src/features/session/drafts.ts"

const HOST = "host_draft_test"

beforeEach(() => {
  clearSessionDraft(HOST, "session-a")
  clearSessionDraft(HOST, "session-b")
})

describe("session drafts", () => {
  test("keeps a separate draft for each session", () => {
    writeSessionDraft(HOST, "session-a", "unfinished prompt A")
    writeSessionDraft(HOST, "session-b", "unfinished prompt B")

    expect(readSessionDraft(HOST, "session-a")).toBe("unfinished prompt A")
    expect(readSessionDraft(HOST, "session-b")).toBe("unfinished prompt B")
    expect(readSessionDraft(HOST, "session-c")).toBe("")
  })

  test("clearing one session leaves other drafts intact", () => {
    writeSessionDraft(HOST, "session-a", "keep me")
    writeSessionDraft(HOST, "session-b", "send me")

    clearSessionDraft(HOST, "session-b")

    expect(readSessionDraft(HOST, "session-a")).toBe("keep me")
    expect(readSessionDraft(HOST, "session-b")).toBe("")
  })

  test("isolates drafts between hosts", () => {
    writeSessionDraft(HOST, "session-a", "host one")
    writeSessionDraft("host_draft_other", "session-a", "host two")

    expect(readSessionDraft(HOST, "session-a")).toBe("host one")
    expect(readSessionDraft("host_draft_other", "session-a")).toBe("host two")
  })
})
