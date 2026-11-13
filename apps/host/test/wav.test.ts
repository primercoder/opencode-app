import { describe, expect, test } from "bun:test"
import { parseWav } from "../src/asr/wav.ts"

function wav(samples: number[], sampleRate = 16_000, channels = 1, bits = 16): Uint8Array {
  const data = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) data.writeInt16LE(samples[index] ?? 0, index * 2)
  const out = Buffer.alloc(44 + data.length)
  out.write("RIFF", 0)
  out.writeUInt32LE(36 + data.length, 4)
  out.write("WAVE", 8)
  out.write("fmt ", 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * channels * (bits / 8), 28)
  out.writeUInt16LE(channels * (bits / 8), 32)
  out.writeUInt16LE(bits, 34)
  out.write("data", 36)
  out.writeUInt32LE(data.length, 40)
  data.copy(out, 44)
  return new Uint8Array(out)
}

describe("WAV parser", () => {
  test("reads 16 kHz mono PCM and normalizes samples", () => {
    const result = parseWav(wav([0, 16384, -16384]))
    expect(result.sampleRate).toBe(16_000)
    expect(result.channels).toBe(1)
    expect(Array.from(result.samples)).toEqual([0, 0.5, -0.5])
  })

  test("rejects stereo and non-16-bit audio", () => {
    expect(() => parseWav(wav([0, 0], 16_000, 2))).toThrow(/mono/u)
    expect(() => parseWav(wav([0], 16_000, 1, 8))).toThrow(/16-bit/u)
  })

  test("rejects non-WAV data", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow(/WAV/u)
  })
})
