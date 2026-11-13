/** Wrap signed 16-bit mono PCM in a minimal RIFF/WAVE container. */
export function pcmToWav(samples: Int16Array, sampleRate = 16_000): Uint8Array {
  const dataBytes = samples.byteLength
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  writeAscii(out, 0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(out, 8, "WAVE")
  writeAscii(out, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(out, 36, "data")
  view.setUint32(40, dataBytes, true)
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44)
  return out
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) target[offset + index] = text.charCodeAt(index)
}
