import * as ExpoCrypto from "expo-crypto"

type RandomSource = {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T
}

/**
 * @noble/curves needs crypto.getRandomValues. Hermes does not always expose it,
 * and Expo Crypto provides the same platform CSPRNG.
 */
export function installCryptoPolyfill(): void {
  const target = globalThis as unknown as { crypto?: RandomSource }
  if (!target.crypto) target.crypto = {} as RandomSource
  if (typeof target.crypto.getRandomValues === "function") return
  target.crypto.getRandomValues = (array) =>
    ExpoCrypto.getRandomValues(array as Parameters<typeof ExpoCrypto.getRandomValues>[0]) as never
}
