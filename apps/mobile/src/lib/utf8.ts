/**
 * Minimal UTF-8 fallback for Hermes builds without TextEncoder/TextDecoder.
 * Only the methods used by the protocol are implemented.
 */
export function encodeUtf8(input: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < input.length; index += 1) {
    let code = input.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        index += 1
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(bytes)
}

export function decodeUtf8(input: ArrayBuffer | ArrayBufferView): string {
  const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input)
  let output = ""
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index++] ?? 0
    if (first < 0x80) {
      output += String.fromCharCode(first)
      continue
    }
    if ((first & 0xe0) === 0xc0) {
      const second = bytes[index++] ?? 0
      output += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f))
      continue
    }
    if ((first & 0xf0) === 0xe0) {
      const second = bytes[index++] ?? 0
      const third = bytes[index++] ?? 0
      output += String.fromCharCode(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f))
      continue
    }
    if ((first & 0xf8) === 0xf0) {
      const second = bytes[index++] ?? 0
      const third = bytes[index++] ?? 0
      const fourth = bytes[index++] ?? 0
      const code = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
      output += String.fromCodePoint(code)
      continue
    }
    output += "\uFFFD"
  }
  return output
}
