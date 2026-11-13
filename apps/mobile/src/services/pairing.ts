import type { PairingOffer } from "@ocremote/protocol"
import { deviceInfo } from "@/config/device"
import { useHosts, type HostRecord } from "@/stores/hosts"
import { HostError, HostRuntime, type HostSession, type RelayAuthResolver } from "@/transport/hostRuntime"

export type PairingStage = "connecting" | "handshaking" | "authenticating" | "saving"

/** Resolves a raw pairing link, short HTTP pairing URL, or JSON wrapper. */
export async function resolvePairingInput(value: string): Promise<string> {
  const trimmed = value.trim()
  if (!/^https?:\/\//u.test(trimmed)) return trimmed
  const response = await fetch(trimmed, { headers: { accept: "text/plain" } })
  if (!response.ok) throw new Error(`pairing link returned HTTP ${response.status}`)
  const text = (await response.text()).trim()
  if (text.startsWith("ocremote://")) return text
  try {
    const payload = JSON.parse(text) as { offer?: unknown }
    if (typeof payload.offer === "string") return payload.offer
  } catch {
    // not JSON
  }
  return text
}

export async function pairWithOffer(
  offer: PairingOffer,
  onStage?: (stage: PairingStage) => void,
  options: { relayAuth?: RelayAuthResolver } = {},
): Promise<{ host: HostRecord; session: HostSession }> {
  const runtime = HostRuntime.fromPairingOffer(offer, {
    device: deviceInfo,
    autoReconnect: false,
    ...(options.relayAuth ? { relayAuth: options.relayAuth } : {}),
  })

  runtime.onStateChange((state) => {
    if (state === "connecting" || state === "handshaking" || state === "authenticating") onStage?.(state)
  })

  try {
    const session = await runtime.connect()
    if (!session.device?.id || !session.token) {
      throw new HostError("protocol", "主机没有返回设备凭据")
    }
    onStage?.("saving")
    const host = await useHosts.getState().addHost(offer)
    await useHosts.getState().saveConnection(host.id, {
      deviceId: session.device.id,
      token: session.token,
    })
    return { host, session }
  } finally {
    runtime.disconnect()
  }
}
