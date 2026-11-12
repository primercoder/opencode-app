import { describe, expect, test } from "bun:test"
import { parsePatch } from "../src/opencode/diff.ts"

describe("unified diff parser", () => {
  test("tracks old and new line numbers across hunks", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index ce01362..94954ab 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " hello",
      "+world",
      " goodbye",
      "@@ -10,2 +11,2 @@",
      "-old",
      "+new",
      " same",
    ].join("\n")

    const lines = parsePatch(patch)

    expect(lines.find((line) => line.text === " hello")).toMatchObject({ kind: "context", oldLine: 1, newLine: 1 })
    expect(lines.find((line) => line.text === "+world")).toMatchObject({ kind: "add", newLine: 2 })
    expect(lines.find((line) => line.text === " goodbye")).toMatchObject({ kind: "context", oldLine: 2, newLine: 3 })
    expect(lines.find((line) => line.text === "-old")).toMatchObject({ kind: "del", oldLine: 10 })
    expect(lines.find((line) => line.text === "+new")).toMatchObject({ kind: "add", newLine: 11 })
    expect(lines.find((line) => line.text === " same")).toMatchObject({ kind: "context", oldLine: 11, newLine: 12 })
  })

  test("marks file metadata and no-newline notices", () => {
    const lines = parsePatch(["--- a/a", "+++ b/a", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n"))
    expect(lines[0]?.kind).toBe("meta")
    expect(lines[1]?.kind).toBe("meta")
    expect(lines[5]?.kind).toBe("meta")
  })

  test("ignores the trailing empty line", () => {
    const lines = parsePatch("@@ -1 +1 @@\n-a\n+b\n")
    expect(lines).toHaveLength(3)
  })
})
