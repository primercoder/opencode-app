import { describe, expect, test } from "bun:test"
import { decodeFrame, encodeFrame, MAX_FRAME_BYTES } from "../src/frames.ts"

describe("OCRP frames", () => {
  test("round-trips a control frame with a stream id", () => {
    const value = { t: "ping", id: 7, ts: 1762915200000 }
    const bytes = encodeFrame({ kind: "control", streamId: 42, value })

    const decoded = decodeFrame(bytes)

    expect(decoded).toEqual({ kind: "control", streamId: 42, value })
  })

  test("round-trips binary data", () => {
    const bytes = encodeFrame({
      kind: "binary",
      streamId: 3,
      data: new Uint8Array([0, 1, 2, 255]),
    })

    expect(decodeFrame(bytes)).toEqual({
      kind: "binary",
      streamId: 3,
      data: new Uint8Array([0, 1, 2, 255]),
    })
  })

  test("rejects a truncated frame", () => {
    expect(() => decodeFrame(new Uint8Array([1, 0]))).toThrow()
  })

  test("rejects an unknown frame kind", () => {
    expect(() => decodeFrame(new Uint8Array([9, 0, 0, 0, 1]))).toThrow()
  })

  test("rejects invalid JSON control payloads", () => {
    const header = new Uint8Array([1, 0, 0, 0, 1])
    const body = new TextEncoder().encode("{not json")
    const bytes = new Uint8Array(header.length + body.length)
    bytes.set(header)
    bytes.set(body, header.length)

    expect(() => decodeFrame(bytes)).toThrow()
  })

  test("rejects frames over the configured maximum", () => {
    expect(() =>
      encodeFrame({
        kind: "binary",
        streamId: 1,
        data: new Uint8Array(MAX_FRAME_BYTES + 1),
      }),
    ).toThrow()
  })
})
