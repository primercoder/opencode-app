import { describe, expect, test } from "bun:test"
import { CipherState } from "../src/noise/index.ts"
import { decodeProtectedRecord, encodeProtectedRecord, MAX_CHUNK_DATA_BYTES } from "../src/records.ts"

function pair() {
  const key = new Uint8Array(32).fill(9)
  const send = new CipherState()
  const receive = new CipherState()
  send.initializeKey(key)
  receive.initializeKey(key)
  return { send, receive }
}

describe("protected records", () => {
  test("round-trips a small binary frame", () => {
    const { send, receive } = pair()
    const frame = new Uint8Array([0, 1, 2, 3, 255])
    const record = encodeProtectedRecord("binary", frame, send)

    expect(decodeProtectedRecord(record, receive)).toEqual({ kind: "binary", data: frame })
  })

  test("round-trips a chunked text frame", () => {
    const { send, receive } = pair()
    const frame = new TextEncoder().encode("x".repeat(MAX_CHUNK_DATA_BYTES + 10))
    const record = encodeProtectedRecord("text", frame, send)

    const decoded = decodeProtectedRecord(record, receive)
    expect(decoded.kind).toBe("text")
    expect(new TextDecoder().decode(decoded.data)).toBe("x".repeat(MAX_CHUNK_DATA_BYTES + 10))
  })

  test("rejects a tampered record", () => {
    const { send, receive } = pair()
    const record = encodeProtectedRecord("binary", new Uint8Array([1, 2, 3]), send)
    record[record.length - 1] ^= 0xff

    expect(() => decodeProtectedRecord(record, receive)).toThrow()
  })

  test("rejects trailing bytes after a complete frame", () => {
    const { send, receive } = pair()
    const record = encodeProtectedRecord("binary", new Uint8Array([1, 2, 3]), send)
    const extended = new Uint8Array(record.length + 1)
    extended.set(record)
    extended[record.length] = 0

    expect(() => decodeProtectedRecord(extended, receive)).toThrow()
  })
})
