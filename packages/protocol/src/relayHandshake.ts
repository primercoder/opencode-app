import { CipherState } from "./noise/cipher-state.ts"
import { createNoiseInitiator } from "./noise/index.ts"
import { base64UrlDecode, base64UrlEncode } from "./pairing.ts"

/**
 * Relay connections use Noise NK with the relay's static X25519 key from the
 * invite. No certificates and no CA: the invite pins the relay identity.
 */
export const RELAY_NOISE_PROLOGUE = new TextEncoder().encode("ocremote-relay-v3")
export const RELAY_CONTROL_PREFIX = "n:"

export type RelayHandshakeResult = {
  welcome: Record<string, unknown>
  send: CipherState
  receive: CipherState
}

export type RelayHandshakeSocket = {
  binaryType?: string
  // Deliberately broad so the same helper works with the browser, Bun and
  // React Native WebSocket implementations.
  onmessage: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onclose: ((event: any) => void) | null
  send(data: ArrayBuffer | Uint8Array | string): void
}

/**
 * Runs the client side of the relay Noise handshake. The handshake payload is
 * the old `relay.hello` JSON; the relay answers with `relay.welcome` inside the
 * encrypted second handshake message.
 */
export async function relayNoiseHandshake(
  socket: RelayHandshakeSocket,
  relayKey: string,
  hello: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<RelayHandshakeResult> {
  const noise = createNoiseInitiator({
    remoteStatic: base64UrlDecode(relayKey),
    prologue: RELAY_NOISE_PROLOGUE,
  })
  const first = noise.writeMessage(new TextEncoder().encode(JSON.stringify(hello)))

  return new Promise<RelayHandshakeResult>((resolve, reject) => {
    const previousMessage = socket.onmessage
    const previousError = socket.onerror
    const previousClose = socket.onclose
    let settled = false

    const cleanup = () => {
      socket.onmessage = previousMessage
      socket.onerror = previousError
      socket.onclose = previousClose
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error("relay Noise handshake timed out")), timeoutMs)

    socket.onmessage = (event) => {
      void (async () => {
        if (settled) return
        const data = await binaryData(event.data)
        if (!data) {
          fail(new Error("relay returned a non-binary handshake frame"))
          return
        }
        try {
          const payload = noise.readMessage(data)
          const parsed: unknown = JSON.parse(new TextDecoder().decode(payload))
          if (!isRecord(parsed)) throw new Error("relay welcome is not a JSON object")
          const keys = noise.split()
          settled = true
          clearTimeout(timer)
          cleanup()
          resolve({ welcome: parsed, send: keys.send, receive: keys.receive })
        } catch (error) {
          fail(error instanceof Error ? error : new Error("relay Noise handshake failed"))
        }
      })()
    }
    socket.onerror = () => fail(new Error("relay connection failed during handshake"))
    socket.onclose = () => fail(new Error("relay closed during handshake"))

    try {
      socket.send(asArrayBuffer(first))
    } catch (error) {
      fail(error instanceof Error ? error : new Error("could not send relay handshake"))
    }
  })
}

/** Encrypts one relay control JSON message for post-auth host control frames. */
export function encodeRelayControl(cipher: CipherState, text: string): string {
  const ciphertext = cipher.encryptWithAd(new Uint8Array(), new TextEncoder().encode(text))
  return RELAY_CONTROL_PREFIX + base64UrlEncode(ciphertext)
}

/** Decrypts one relay control frame; returns null for malformed input. */
export function decodeRelayControl(cipher: CipherState, text: string): string | null {
  if (!text.startsWith(RELAY_CONTROL_PREFIX)) return null
  try {
    const ciphertext = base64UrlDecode(text.slice(RELAY_CONTROL_PREFIX.length))
    const plaintext = cipher.decryptWithAd(new Uint8Array(), ciphertext)
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function binaryData(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
