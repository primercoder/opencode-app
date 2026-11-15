import type { PairingOffer } from "@ocremote/protocol"
import { create } from "zustand"
import { mergeTransports, normalizeTransports } from "@/lib/transports"
import {
  loadCredentials,
  loadHosts,
  removeCredentials,
  saveCredentials,
  saveHosts,
  type HostCredentials,
  type HostRecord,
} from "@/storage/hosts"

export type { HostRecord } from "@/storage/hosts"

type HostState = {
  hosts: HostRecord[]
  hydrated: boolean
  activeHostId?: string
  hydrate(): Promise<void>
  addHost(offer: PairingOffer): Promise<HostRecord>
  saveConnection(hostId: string, credentials: HostCredentials, transport?: string): Promise<void>
  touchHost(hostId: string, transport?: string): Promise<void>
  renameHost(hostId: string, name: string): Promise<void>
  setTransports(hostId: string, transports: HostRecord["transports"]): Promise<void>
  removeHost(hostId: string): Promise<void>
  setActive(hostId: string | undefined): void
  getHost(hostId: string): HostRecord | undefined
}

export const useHosts = create<HostState>((set, get) => ({
  hosts: [],
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return
    const hosts = (await loadHosts()).sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0))
    set({ hosts, hydrated: true })
  },

  async addHost(offer) {
    const incoming = offer.transports.map((transport) => {
      if (transport.kind !== "relay") return transport
      // Pairing invites are single-use and already consumed by the time the
      // host is saved. Keep the room/URL, but do not persist the token.
      const { invite: _invite, ...rest } = transport
      return rest
    })
    const existing = get().hosts.find((host) => host.id === offer.hostId)
    if (existing) {
      const transports = mergeTransports(existing.transports, incoming)
      const updated: HostRecord = {
        ...existing,
        name: offer.name,
        publicKey: offer.pk,
        fingerprint: offer.fingerprint,
        transports,
      }
      const hosts = get().hosts.map((host) => (host.id === updated.id ? updated : host))
      set({ hosts })
      await saveHosts(hosts)
      return updated
    }
    const host: HostRecord = {
      id: offer.hostId,
      name: offer.name,
      publicKey: offer.pk,
      fingerprint: offer.fingerprint,
      transports: normalizeTransports(incoming),
    }
    const hosts = [...get().hosts, host]
    set({ hosts })
    await saveHosts(hosts)
    return host
  },

  async saveConnection(hostId, credentials, transport) {
    const hosts = get().hosts.map((host) =>
      host.id === hostId
        ? {
            ...host,
            lastConnectedAt: Date.now(),
            ...(transport ? { lastTransport: transport } : {}),
          }
        : host,
    )
    set({ hosts, activeHostId: hostId })
    await Promise.all([saveHosts(hosts), saveCredentials(hostId, credentials)])
  },

  async touchHost(hostId, transport) {
    const hosts = get().hosts.map((host) =>
      host.id === hostId
        ? {
            ...host,
            lastConnectedAt: Date.now(),
            ...(transport ? { lastTransport: transport } : {}),
          }
        : host,
    )
    set({ hosts, activeHostId: hostId })
    await saveHosts(hosts)
  },

  async renameHost(hostId, name) {
    const trimmed = name.trim()
    if (!trimmed) return
    const hosts = get().hosts.map((host) => (host.id === hostId ? { ...host, name: trimmed } : host))
    set({ hosts })
    await saveHosts(hosts)
  },

  async setTransports(hostId, transports) {
    const normalized = normalizeTransports(transports)
    const hosts = get().hosts.map((host) =>
      host.id === hostId
        ? {
            ...host,
            transports: normalized,
          }
        : host,
    )
    set({ hosts })
    await saveHosts(hosts)
  },

  async removeHost(hostId) {
    const hosts = get().hosts.filter((host) => host.id !== hostId)
    set({ hosts, ...(get().activeHostId === hostId ? { activeHostId: undefined } : {}) })
    await Promise.all([saveHosts(hosts), removeCredentials(hostId)])
  },

  setActive(hostId) {
    set({ activeHostId: hostId })
  },

  getHost(hostId) {
    return get().hosts.find((host) => host.id === hostId)
  },
}))

export async function credentialsFor(hostId: string): Promise<HostCredentials | undefined> {
  return loadCredentials(hostId)
}
