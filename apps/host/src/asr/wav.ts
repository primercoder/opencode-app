export type PcmAudio = {
  samples: Float32Array
  sampleRate: number
  channels: number
  durationMs: number
}

/**
 * Minimal WAV reader for phone dictation: RIFF/WAVE, PCM 16-bit little-endian.
 * The phone records mono 16 kHz WAV, so keeping the parser strict avoids
 * accepting arbitrary audio formats the recognizer cannot handle.
 */
export function parseWav(bytes: Uint8Array): PcmAudio {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("expected a RIFF/WAVE file")
  }

  let offset = 12
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | undefined
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4)
    const length = readU32(bytes, offset + 4)
    const body = offset + 8
    if (body + length > bytes.byteLength) break
    if (id === "fmt ") {
      if (length < 16) throw new Error("invalid fmt chunk")
      format = {
        audioFormat: readU16(bytes, body),
        channels: readU16(bytes, body + 2),
        sampleRate: readU32(bytes, body + 4),
        bits: readU16(bytes, body + 14),
      }
    } else if (id === "data") {
      dataOffset = body
      dataLength = length
      break
    }
    offset = body + length + (length % 2)
  }

  if (!format) throw new Error("WAV fmt chunk is missing")
  if (dataOffset < 0) throw new Error("WAV data chunk is missing")
  if (format.audioFormat !== 1) throw new Error("only PCM WAV is supported")
  if (format.channels !== 1) throw new Error("only mono WAV is supported")
  if (format.bits !== 16) throw new Error("only 16-bit WAV is supported")
  if (format.sampleRate < 8_000 || format.sampleRate > 96_000) throw new Error("unsupported sample rate")

  const count = Math.floor(dataLength / 2)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    samples[index] = readI16(bytes, dataOffset + index * 2) / 32768
  }

  return {
    samples,
    sampleRate: format.sampleRate,
    channels: format.channels,
    durationMs: Math.round((count / format.sampleRate) * 1000),
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readI16(bytes: Uint8Array, offset: number): number {
  const value = readU16(bytes, offset)
  return value >= 0x8000 ? value - 0x10000 : value
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0
}
