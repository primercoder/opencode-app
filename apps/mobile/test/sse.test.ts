import { describe, expect, test } from "bun:test"
import { SseParser } from "../src/transport/sse.ts"

describe("SSE parser", () => {
  test("parses events split across chunks", () => {
    const parser = new SseParser()
    expect(parser.push('event: message\ndata: {"type":"a"}')).toEqual([])
    expect(parser.push("\n\n")).toEqual([{ event: "message", data: '{"type":"a"}' }])
  })

  test("joins multi-line data and keeps ids", () => {
    const parser = new SseParser()
    const events = parser.push('id: 42\ndata: first\ndata: second\n\ndata: third\n\n')
    expect(events).toEqual([
      { id: "42", data: "first\nsecond" },
      { data: "third" },
    ])
  })

  test("handles CRLF and comments", () => {
    const parser = new SseParser()
    const events = parser.push(": keepalive\r\nevent: ping\r\ndata: ok\r\n\r\n")
    expect(events).toEqual([{ event: "ping", data: "ok" }])
  })

  test("flushes a final event without a blank line", () => {
    const parser = new SseParser()
    expect(parser.push("data: {}\n")).toEqual([])
    expect(parser.flush()).toEqual([{ data: "{}" }])
  })
})
