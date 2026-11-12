import type { PairingOffer, Transport } from "@ocremote/protocol"
import { create } from "zustand"

export type HostRecord = {
  id: string
  name: string
  pairingUrl: string
  transports: Transport[]
  lastConnectedAt?: number
}

type HostState = {
  hosts: HostRecord[]
  addHost(offer: PairingOffer, pairingUrl: string): HostRecord
  removeHost(id: string): void
  touchHost(id: string): void
}

export const useHosts = create<HostState>((set, get) => ({
  // TODO(P0.2): persist host metadata in SQLite; tokens will live in SecureStore.
  hosts: [],
  addHost(offer, pairingUrl) {
    const existing = get().hosts.find((host) => host.id === offer.hostId)
    if (existing) return existing
    const host: HostRecord = {
      id: offer.hostId,
      name: offer.name,
      pairingUrl,
      transports: offer.transports,
    }
    set((state) => ({ hosts: [...state.hosts, host] }))
    return host
  },
  removeHost(id) {
    set((state) => ({ hosts: state.hosts.filter((host) => host.id !== id) }))
  },
  touchHost(id) {
    set((state) => ({
      hosts: state.hosts.map((host) => (host.id === id ? { ...host, lastConnectedAt: Date.now() } : host)),
    }))
  },
}))
