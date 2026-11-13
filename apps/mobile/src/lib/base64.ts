const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const VALUES = new Map<string, number>(Array.from(ALPHABET, (char, index) => [char, index] as const))

/** Standard base64 decoder for binary websocket/audio payloads. */
export function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/u, "")
  if (clean.length % 4 === 1) throw new Error("invalid base64 length")
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let offset = 0
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const decoded = VALUES.get(char)
    if (decoded === undefined) throw new Error("invalid base64 character")
    buffer = (buffer << 6) | decoded
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[offset++] = (buffer >> bits) & 0xff
    }
  }
  return out
}

/** Standard base64 encoder for ASR chunks. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    out += ALPHABET[first >> 2]
    out += ALPHABET[((first & 0x03) << 4) | (second === undefined ? 0 : second >> 4)]
    if (second === undefined) {
      out += "=="
      break
    }
    out += ALPHABET[((second & 0x0f) << 2) | (third === undefined ? 0 : third >> 6)]
    if (third === undefined) {
      out += "="
      break
    }
    out += ALPHABET[third & 0x3f]
  }
  return out
}
