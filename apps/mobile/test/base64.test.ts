import { describe, expect, test } from "bun:test"
import { decodeBase64, encodeBase64 } from "../src/lib/base64.ts"

describe("base64 decoder", () => {
  test("decodes standard base64 with padding", () => {
    expect(Array.from(decodeBase64("aGVsbG8="))).toEqual([104, 101, 108, 108, 111])
    expect(Array.from(decodeBase64("AAEC/w=="))).toEqual([0, 1, 2, 255])
  })

  test("encodes standard base64 with padding", () => {
    expect(encodeBase64(new Uint8Array([104, 101, 108, 108, 111]))).toBe("aGVsbG8=")
    expect(encodeBase64(new Uint8Array([0, 1, 2, 255]))).toBe("AAEC/w==")
  })

  test("rejects invalid input", () => {
    expect(() => decodeBase64("a$b")).toThrow()
  })
})
