import { describe, expect, test } from "bun:test"
import { decodeUtf8, encodeUtf8 } from "../src/lib/utf8.ts"

describe("utf8 fallback", () => {
  test("round-trips ASCII, Chinese and emoji", () => {
    const text = "hello 你好 👋🏻 — opencode"
    expect(decodeUtf8(encodeUtf8(text))).toBe(text)
  })

  test("matches TextEncoder byte output", () => {
    const text = "a中🙂"
    expect(Array.from(encodeUtf8(text))).toEqual(Array.from(new TextEncoder().encode(text)))
  })

  test("decodes a partial buffer view", () => {
    const buffer = encodeUtf8("xx你好yy")
    const view = buffer.subarray(2, buffer.length - 2)
    expect(decodeUtf8(view)).toBe("你好")
  })
})
