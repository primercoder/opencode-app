import * as ExpoCrypto from "expo-crypto"
import { decodeUtf8, encodeUtf8 } from "@/lib/utf8"

type RandomSource = {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T
}

/**
 * @noble/curves needs crypto.getRandomValues. Hermes does not always expose it,
 * and Expo Crypto provides the same platform CSPRNG.
 */
export function installRuntimePolyfills(): void {
  installCrypto()
  installTextEncoding()
}

function installCrypto(): void {
  const target = globalThis as unknown as { crypto?: RandomSource }
  if (!target.crypto) target.crypto = {} as RandomSource
  if (typeof target.crypto.getRandomValues === "function") return
  target.crypto.getRandomValues = (array) =>
    ExpoCrypto.getRandomValues(array as Parameters<typeof ExpoCrypto.getRandomValues>[0]) as never
}

function installTextEncoding(): void {
  const target = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown }
  if (typeof target.TextEncoder !== "function") {
    target.TextEncoder = class {
      encode(input = ""): Uint8Array {
        return encodeUtf8(input)
      }
    }
  }
  if (typeof target.TextDecoder !== "function") {
    target.TextDecoder = class {
      decode(input?: ArrayBuffer | ArrayBufferView): string {
        return input ? decodeUtf8(input) : ""
      }
    }
  }
}

