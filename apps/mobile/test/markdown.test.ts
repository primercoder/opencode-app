import { describe, expect, test } from "bun:test"
import { parseMarkdown } from "../src/lib/markdown.ts"

describe("markdown parser", () => {
  test("keeps fenced code intact and strips the fence", () => {
    const blocks = parseMarkdown("Before\n\n```ts\nconst a = 1\n```")
    expect(blocks[0]).toEqual({ type: "paragraph", text: "Before" })
    expect(blocks[1]).toEqual({ type: "code", lang: "ts", text: "const a = 1" })
  })

  test("parses headings, lists and quotes", () => {
    const blocks = parseMarkdown("# Title\n\n- one\n- two\n\n> quoted")
    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "Title" })
    expect(blocks[1]).toMatchObject({ type: "list", ordered: false })
    expect(blocks[2]).toEqual({ type: "quote", text: "quoted" })
  })

  test("parses tables and rules", () => {
    const blocks = parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n---")
    expect(blocks[0]).toEqual({ type: "table", rows: [["a", "b"], ["1", "2"]] })
    expect(blocks[1]).toEqual({ type: "rule" })
  })
})
