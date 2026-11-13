import { describe, expect, test } from "bun:test"
import { pcmToWav } from "../src/features/voice/wav.ts"

describe("PCM to WAV", () => {
  test("writes a 16 kHz mono PCM header", () => {
    const wav = pcmToWav(new Int16Array([0, 1000, -1000]))
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF")
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE")
    expect(wav.byteLength).toBe(44 + 6)
    const view = new DataView(wav.buffer)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(6)
  })
})
