import { beforeEach, describe, expect, test } from "bun:test"
import { useReviewDrafts } from "../src/stores/reviewDrafts.ts"
import type { ReviewComment } from "../src/opencode/review.ts"

function comment(path: string, line: number, text: string): ReviewComment {
  return {
    type: "file",
    path,
    selection: { startLine: line, endLine: line, startChar: 0, endChar: 0 },
    comment: text,
    preview: "",
    origin: "review",
  }
}

describe("staged review comments", () => {
  beforeEach(() => {
    useReviewDrafts.setState({ bySession: {} })
  })

  test("keeps comments on the phone until the session sends", () => {
    const store = useReviewDrafts.getState()
    store.add("ses_a", "/work", [comment("a.ts", 3, "first")])
    store.add("ses_a", "/work", [comment("b.ts", 9, "second")])

    const staged = useReviewDrafts.getState().bySession.ses_a
    expect(staged?.directory).toBe("/work")
    expect(staged?.comments.map((item) => item.comment)).toEqual(["first", "second"])
    expect(useReviewDrafts.getState().bySession.ses_b).toBeUndefined()
  })

  test("removes a single card and clears the session on send", () => {
    const store = useReviewDrafts.getState()
    store.add("ses_a", "/work", [comment("a.ts", 1, "one"), comment("b.ts", 2, "two")])
    store.remove("ses_a", 0)
    expect(useReviewDrafts.getState().bySession.ses_a?.comments.map((item) => item.comment)).toEqual(["two"])

    store.clear("ses_a")
    expect(useReviewDrafts.getState().bySession.ses_a).toBeUndefined()
  })
})
