export type OcrpFrameKind = "control" | "binary"

export type OcrpControlFrame = {
  t: string
  [key: string]: unknown
}

export type OcrpFrame =
  | { kind: "control"; streamId: number; value: OcrpControlFrame }
  | { kind: "binary"; streamId: number; data: Uint8Array }

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_STREAM_ID = 0xffff_ffff

const KIND_CONTROL = 0x01
const KIND_BINARY = 0x02
const HEADER_BYTES = 5

export function encodeFrame(frame: OcrpFrame): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > MAX_STREAM_ID) {
    throw new Error("invalid stream id")
  }

  const payload =
    frame.kind === "control" ? new TextEncoder().encode(JSON.stringify(frame.value)) : frame.data
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error("frame too large")

  const out = new Uint8Array(HEADER_BYTES + payload.byteLength)
  out[0] = frame.kind === "control" ? KIND_CONTROL : KIND_BINARY
  writeU32(out, 1, frame.streamId)
  out.set(payload, HEADER_BYTES)
  return out
}

export function decodeFrame(bytes: Uint8Array): OcrpFrame {
  if (bytes.byteLength < HEADER_BYTES) throw new Error("frame truncated")
  const kind = bytes[0]
  const streamId = readU32(bytes, 1)
  const payload = bytes.subarray(HEADER_BYTES)
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error("frame too large")

  if (kind === KIND_CONTROL) {
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(payload))
    } catch {
      throw new Error("invalid control frame JSON")
    }
    if (!value || typeof value !== "object" || typeof (value as { t?: unknown }).t !== "string") {
      throw new Error("control frame must contain a string t")
    }
    return { kind: "control", streamId, value: value as OcrpControlFrame }
  }

  if (kind === KIND_BINARY) return { kind: "binary", streamId, data: payload.slice() }

  throw new Error("unknown frame kind")
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0
}
