import { create } from "zustand"
import type { ConnectionState, HostError, HostSession } from "@/transport/hostRuntime"

export type HostConnection = {
  status: ConnectionState
  transport?: "lan" | "relay" | "custom"
  latencyMs?: number
  session?: HostSession
  error?: { kind: HostError["kind"]; message: string; code?: string }
  lastSyncedAt?: number
}

type ConnectionState_ = {
  byHost: Record<string, HostConnection>
  patch(hostId: string, patch: Partial<HostConnection>): void
  remove(hostId: string): void
}

const IDLE: HostConnection = { status: "idle" }

export const useConnections = create<ConnectionState_>((set) => ({
  byHost: {},
  patch(hostId, patch) {
    set((state) => ({
      byHost: {
        ...state.byHost,
        [hostId]: { ...(state.byHost[hostId] ?? IDLE), ...patch },
      },
    }))
  },
  remove(hostId) {
    set((state) => {
      const next = { ...state.byHost }
      delete next[hostId]
      return { byHost: next }
    })
  },
}))

export function connectionFor(hostId: string): HostConnection {
  return useConnections.getState().byHost[hostId] ?? IDLE
}
