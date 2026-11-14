import { describe, expect, test } from "bun:test"
import { contentKind, isProbablyBinary } from "../src/opencode/fileKind.ts"

describe("file kind detection", () => {
  test("treats TypeScript as text even when the server claims video/mp2t", () => {
    expect(contentKind("src/app.ts")).toBe("text")
    expect(isProbablyBinary("export const value = 1\n", "video/mp2t", "src/app.ts")).toBe(false)
  })

  test("keeps common source and config files textual", () => {
    for (const path of ["index.tsx", "main.go", "Cargo.toml", "package.json", "README.md", "style.css", "run.sh"]) {
      expect(isProbablyBinary("hello\nworld\n", "application/octet-stream", path)).toBe(false)
    }
  })

  test("recognises binary extensions and NUL bytes", () => {
    expect(isProbablyBinary("not really an image", "text/plain", "photo.png")).toBe(true)
    expect(isProbablyBinary("PK\u0003\u0004", "application/octet-stream", "archive.zip")).toBe(true)
    expect(isProbablyBinary("abc\u0000def", "text/plain", "notes.txt")).toBe(true)
  })

  test("keeps SVG previewable", () => {
    expect(isProbablyBinary('<svg viewBox="0 0 1 1"></svg>', "image/svg+xml", "icon.svg")).toBe(false)
  })

  test("rejects unknown binary-looking content", () => {
    const data = Array.from({ length: 100 }, (_, index) => (index % 4 === 0 ? "\u0001" : "x")).join("")
    expect(isProbablyBinary(data, "application/octet-stream", "unknown.data")).toBe(true)
  })
})
