import type { Transport } from "@ocremote/protocol"

export type RouteKind = "lan" | "relay" | "custom"

/** A host keeps at most one direct and one relay route, direct first. */
export function normalizeTransports(input: Transport[]): Transport[] {
  const byKind = new Map<RouteKind, Transport>()
  for (const transport of input) {
    byKind.set(transport.kind, transport)
  }
  let result = [...byKind.values()]
  if (result.some((transport) => transport.kind === "relay")) {
    result = result.filter((transport) => transport.kind !== "lan" || !isLoopbackUrl(transport.url))
  }
  return result
    .filter((transport) => transport.kind !== "custom")
    .sort((left, right) => priority(left.kind) - priority(right.kind))
    .map((transport, index) => ({ ...transport, priority: index }))
}

export function mergeTransports(existing: Transport[], incoming: Transport[]): Transport[] {
  return normalizeTransports([...existing, ...incoming])
}

export function replaceTransport(routes: Transport[], next: Transport): Transport[] {
  return normalizeTransports([...routes.filter((route) => route.kind !== next.kind), next])
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
  } catch {
    return false
  }
}

function priority(kind: RouteKind): number {
  return kind === "lan" ? 0 : kind === "relay" ? 1 : 2
}
