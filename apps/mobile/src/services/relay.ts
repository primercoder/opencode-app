import { parseRelayInviteLink } from "@ocremote/protocol"
import { deviceInfo } from "@/config/device"
import { normalizeRelayUrl, saveRelayAccess, type RelayAccess } from "@/storage/relay"

export class RelayAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "RelayAccessError"
  }
}

export type RelayEnrollment = {
  url: string
  access: RelayAccess
}

/**
 * Consume a one-time client invite and remember the returned subject secret.
 * The invite token travels only inside the first websocket frame, never in a
 * URL.
 */
export async function enrollRelayClient(input: {
  link: string
  room: string
  name?: string
  timeoutMs?: number
}): Promise<RelayEnrollment> {
  let invite: ReturnType<typeof parseRelayInviteLink>
  try {
    invite = parseRelayInviteLink(input.link)
  } catch (error) {
    throw new RelayAccessError("RELAY_INVITE_INVALID", error instanceof Error ? error.message : "中继访问链接无效")
  }
  if (invite.kind !== "client") {
    throw new RelayAccessError("RELAY_INVITE_INVALID", "这是主机邀请链接，不是手机邀请链接")
  }
  if (!input.room) {
    throw new RelayAccessError("RELAY_ROOM_NOT_FOUND", "缺少主机房间信息，请重新扫描主机配对码")
  }
  const timeoutMs = input.timeoutMs ?? 10_000
  const socket = new WebSocket(invite.url)
  socket.binaryType = "arraybuffer"
  try {
    await waitForOpen(socket, timeoutMs)
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new RelayAccessError("RELAY_TIMEOUT", "中继登记超时"))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return
        let value: unknown
        try {
          value = JSON.parse(event.data)
        } catch {
          return
        }
        if (!isRecord(value)) return
        if (value.t === "relay.error") {
          cleanup()
          reject(new RelayAccessError(stringValue(value.code) || "RELAY_BAD_REQUEST", stringValue(value.message) || "中继登记失败"))
          return
        }
        if (value.t === "relay.welcome") {
          cleanup()
          resolve(value)
        }
      }
      socket.onerror = () => {
        cleanup()
        reject(new RelayAccessError("RELAY_NETWORK", "无法连接中继"))
      }
      socket.onclose = () => {
        cleanup()
        reject(new RelayAccessError("RELAY_NETWORK", "中继在登记完成前断开"))
      }
      socket.send(
        JSON.stringify({
          t: "relay.hello",
          v: 2,
          kind: "client",
          invite: invite.invite,
          room: input.room,
          name: input.name ?? deviceInfo.name,
        }),
      )
    })
    const subjectId = stringValue(welcome.subjectId)
    const secret = stringValue(welcome.secret)
    if (!subjectId || !secret) {
      throw new RelayAccessError("RELAY_BAD_REQUEST", "中继没有返回长期凭据")
    }
    const access: RelayAccess = {
      subjectId,
      secret,
      room: input.room,
      name: input.name ?? deviceInfo.name,
      ...(typeof welcome.relayId === "string" ? { relayId: welcome.relayId } : {}),
      createdAt: Date.now(),
    }
    await saveRelayAccess(invite.url, access)
    const summary: RelayEnrollment = { url: normalizeRelayUrl(invite.url), access }
    return summary
  } finally {
    try {
      socket.close(1000, "enrolled")
    } catch {
      // ignore
    }
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new RelayAccessError("RELAY_TIMEOUT", "连接中继超时"))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.onopen = null
      socket.onerror = null
      socket.onclose = null
    }
    socket.onopen = () => {
      cleanup()
      resolve()
    }
    socket.onerror = () => {
      cleanup()
      reject(new RelayAccessError("RELAY_NETWORK", "无法连接中继"))
    }
    socket.onclose = () => {
      cleanup()
      reject(new RelayAccessError("RELAY_NETWORK", "中继在连接过程中断开"))
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}
