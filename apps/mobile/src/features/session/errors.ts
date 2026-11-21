import { HostError } from "@/transport/hostRuntime"

/**
 * True when a request failed because opencode itself is not running on the
 * host. The host stays reachable in that case, so the UI must say
 * "opencode is not running" instead of "host offline".
 */
export function isOpencodeOffline(error: unknown): boolean {
  if (error instanceof HostError && error.code === "OPENCODE_OFFLINE") return true
  if (error instanceof Error) {
    return /OPENCODE_OFFLINE|opencode is not running/iu.test(error.message)
  }
  return false
}

export function isHostOffline(error: unknown): boolean {
  if (error instanceof HostError) return error.kind === "network" || error.kind === "timeout"
  return false
}

/**
 * True when opencode says the session no longer exists. Only this case should
 * forget the remembered session; a transient network or "opencode offline"
 * failure must keep it so the user returns to the same session later.
 */
export function isMissingSession(error: unknown): boolean {
  if (error instanceof HostError) return error.status === 404 || error.code === "NOT_FOUND"
  if (error instanceof Error) {
    return /\bHTTP 404\b|session not found|unknown session/iu.test(error.message)
  }
  return false
}

/** Short, localizable description for a request failure. */
export function describeError(
  error: unknown,
  t: (key: "error" | "opencodeOffline" | "hostOfflineBody") => string,
): string {
  if (isOpencodeOffline(error)) return t("opencodeOffline")
  if (isHostOffline(error)) return t("hostOfflineBody")
  return error instanceof Error ? error.message : t("error")
}
