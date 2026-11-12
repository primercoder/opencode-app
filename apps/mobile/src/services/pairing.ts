import type { PairingOffer } from "@ocremote/protocol"
import { deviceInfo } from "@/config/device"
import { useHosts, type HostRecord } from "@/stores/hosts"
import { HostError, HostRuntime, type HostSession } from "@/transport/hostRuntime"

export type PairingStage = "connecting" | "handshaking" | "authenticating" | "saving"

export async function pairWithOffer(
  offer: PairingOffer,
  onStage?: (stage: PairingStage) => void,
): Promise<{ host: HostRecord; session: HostSession }> {
  const runtime = HostRuntime.fromPairingOffer(offer, {
    device: deviceInfo,
    autoReconnect: false,
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
