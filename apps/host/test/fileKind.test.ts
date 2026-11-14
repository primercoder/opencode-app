import { describe, expect, test } from "bun:test"
import { classifyFile, looksBinary } from "../src/fileKind.ts"

describe("host file classification", () => {
  test("classifies source and config as text", () => {
    expect(classifyFile("src/app.ts")).toMatchObject({ kind: "text", previewable: true, language: "typescript" })
    expect(classifyFile("main.go")).toMatchObject({ kind: "text", previewable: true, language: "go" })
    expect(classifyFile("package.json")).toMatchObject({ kind: "text", previewable: true })
    expect(classifyFile("README.md")).toMatchObject({ kind: "text", previewable: true })
  })

  test("classifies media and archives as non-previewable", () => {
    expect(classifyFile("photo.png")).toMatchObject({ kind: "image", previewable: false })
    expect(classifyFile("bundle.zip")).toMatchObject({ kind: "archive", previewable: false })
    expect(classifyFile("report.pdf")).toMatchObject({ kind: "pdf", previewable: false })
    expect(classifyFile("tool.wasm")).toMatchObject({ kind: "binary", previewable: false })
  })

  test("keeps unknown small text previewable and detects binary content", () => {
    expect(classifyFile("notes.unknown")).toMatchObject({ kind: "unknown", previewable: true })
    expect(looksBinary("hello\nworld\n", "text/plain")).toBe(false)
    expect(looksBinary("PK\u0003\u0004\u0000", "application/octet-stream")).toBe(true)
  })
})
