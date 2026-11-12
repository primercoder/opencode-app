import { describe, expect, test } from "bun:test"
import { buildReviewPrompt, selectionRange, type ReviewComment } from "../src/opencode/review.ts"

describe("review comments", () => {
  test("keeps a single tapped line as a one-line range", () => {
    expect(selectionRange({ start: 12 }, 12)).toEqual({ start: 12, end: 12 })
    expect(selectionRange({ start: 12 }, 18)).toEqual({ start: 12, end: 18 })
    expect(selectionRange({ start: 18 }, 12)).toEqual({ start: 12, end: 18 })
  })

  test("builds a prompt with file references and metadata", () => {
    const comments: ReviewComment[] = [
      {
        type: "file",
        path: "src/a.ts",
        selection: { startLine: 12, endLine: 18, startChar: 0, endChar: 0 },
        comment: "这里会覆盖新状态",
        preview: "const current = ...",
        origin: "review",
      },
      {
        type: "file",
        path: "src/b.ts",
        selection: { startLine: 3, endLine: 3, startChar: 0, endChar: 0 },
        comment: "用常量",
        preview: "let x = 1",
        origin: "review",
      },
    ]

    const prompt = buildReviewPrompt("/work/project", comments)

    expect(prompt.text).toBe(
      "The user made the following comment regarding lines 12 through 18 of src/a.ts: 这里会覆盖新状态\n\n" +
        "The user made the following comment regarding lines 3 through 3 of src/b.ts: 用常量",
    )
    expect(prompt.files).toEqual([
      { uri: "file:///work/project/src/a.ts?start=12&end=18", mime: "text/plain", name: "src/a.ts" },
      { uri: "file:///work/project/src/b.ts?start=3&end=3", mime: "text/plain", name: "src/b.ts" },
    ])
    expect(prompt.metadata).toEqual({ comments, attachments: [] })
  })

  test("encodes spaces in file URIs", () => {
    const prompt = buildReviewPrompt("/work/my project", [
      {
        type: "file",
        path: "src/a b.ts",
        selection: { startLine: 1, endLine: 1, startChar: 0, endChar: 0 },
        comment: "hi",
        preview: "",
        origin: "review",
      },
    ])
    expect(prompt.files[0]?.uri).toBe("file:///work/my%20project/src/a%20b.ts?start=1&end=1")
  })
})
