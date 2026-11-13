import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const HOST_VERSION = "0.1.0"

export type HostState = {
  pid: number
  startedAt: number
  listen: string
  lanUrls: string[]
  relay: { url: string; room: string } | null
  opencodeUrl: string
  opencodeVersion?: string
  socketPath: string
  logPath: string
  version: string
}

export type ClientEntry = {
  id: number
  deviceId?: string
  name: string
  platform: string
  scope: "full" | "read"
  transport: "direct" | "relay"
  remoteAddress?: string
  connectedAt: number
  lastSeenAt: number
}

export function stateDir(): string {
  return process.env.OCREMOTE_STATE_DIR ?? join(homedir(), ".local", "state", "ocremote")
}

export function socketPath(): string {
  return join(stateDir(), "control.sock")
}

export function statePath(): string {
  return join(stateDir(), "host.json")
}

export function pidPath(): string {
  return join(stateDir(), "host.pid")
}

export function logPath(): string {
  return join(stateDir(), "host.log")
}

export async function readState(): Promise<HostState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as HostState
  } catch {
    return undefined
  }
}

export async function writeState(state: HostState): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  await chmod(stateDir(), 0o700).catch(() => undefined)
  await writeFile(statePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  await writeFile(pidPath(), `${state.pid}\n`, { mode: 0o600 })
}

export async function clearState(): Promise<void> {
  await rm(statePath(), { force: true }).catch(() => undefined)
  await rm(pidPath(), { force: true }).catch(() => undefined)
}

export async function readPid(): Promise<number | undefined> {
  try {
    const value = Number((await readFile(pidPath(), "utf8")).trim())
    return Number.isInteger(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type ControlCommand =
  | { cmd: "status" }
  | { cmd: "clients" }
  | { cmd: "pair"; scope: "full" | "read"; ttlMinutes: number; url?: string }
  | { cmd: "stop" }

export type ControlResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

/**
 * Talks to a running host over its private Unix socket. Returns undefined when
 * no host is listening (stale socket, host stopped, or permission denied).
 */
export async function control<T>(request: ControlCommand, timeoutMs = 4_000): Promise<T | undefined> {
  let response: Response
  try {
    response = await fetch("http://ocremote-control/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      unix: socketPath(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const payload = (await response.json()) as ControlResult
  if (!payload.ok) throw new Error(payload.error)
  return payload.data as T
}

export async function waitForExit(pid: number, timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await Bun.sleep(100)
  }
  return !isAlive(pid)
}
