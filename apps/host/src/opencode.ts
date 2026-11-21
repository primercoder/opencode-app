import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export type OpencodeTarget = {
  url: string
  password: string
  version?: string
}

export type OpencodeInfo = {
  version?: string
  hostname?: string
  urls?: string[]
  capabilities?: Record<string, unknown>
}

export type OpencodeState = {
  /** A reachable opencode server is registered and answered /api/info. */
  available: boolean
  target?: OpencodeTarget
  /** Last probe failure, kept for status and error messages. */
  error?: string
  checkedAt: number
}

const INFO_TIMEOUT_MS = 5_000

/**
 * Resolves the opencode server once. Kept for callers that must fail fast
 * (the `doctor` command); the running host uses {@link OpencodeMonitor} so it
 * can start before opencode does.
 */
export async function resolveOpencodeTarget(input?: {
  url?: string
  password?: string
}): Promise<OpencodeTarget> {
  if (input?.url) {
    if (!input.password) throw new Error("opencode password is required with --opencode-url")
    return probeOpencode({ url: normalizeUrl(input.url), password: input.password })
  }
  if (process.env.OPENCODE_SERVER_URL) {
    const password = process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD
    if (!password) throw new Error("OPENCODE_PASSWORD is required with OPENCODE_SERVER_URL")
    return probeOpencode({ url: normalizeUrl(process.env.OPENCODE_SERVER_URL), password })
  }

  const registration = await readServiceRegistration()
  if (!registration) {
    throw new Error(
      "opencode service not found. Start it with `opencode service start`, or pass --opencode-url and --opencode-password.",
    )
  }
  return probeOpencode(registration)
}

/**
 * Watches the local opencode service registration. The host must stay up even
 * when opencode is not running, so probe failures never throw: they only flip
 * `available` and are retried on the next tick.
 */
export class OpencodeMonitor {
  private stateValue: OpencodeState = { available: false, checkedAt: 0 }
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly listeners = new Set<(state: OpencodeState) => void>()
  private lastKey: string | undefined
  private refreshing: Promise<void> | undefined

  constructor(
    private readonly options: {
      url?: string
      password?: string
      intervalMs?: number
    } = {},
  ) {}

  get state(): OpencodeState {
    return this.stateValue
  }

  onChange(listener: (state: OpencodeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    await this.refresh()
    if (this.timer) return
    const interval = this.options.intervalMs ?? 5_000
    this.timer = setInterval(() => void this.refresh(), interval)
    // Never keep the process alive only for a probe loop.
    this.timer.unref?.()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  /** Forces one probe and returns the resulting state. */
  async refresh(): Promise<OpencodeState> {
    if (this.refreshing) {
      await this.refreshing
      return this.stateValue
    }
    this.refreshing = this.probe().finally(() => {
      this.refreshing = undefined
    })
    await this.refreshing
    return this.stateValue
  }

  private async probe(): Promise<void> {
    let registration: OpencodeTarget | undefined
    try {
      registration = await this.candidate()
    } catch (error) {
      this.apply({ available: false, error: messageOf(error), checkedAt: Date.now() })
      return
    }
    if (!registration) {
      this.lastKey = undefined
      this.apply({
        available: false,
        error: "opencode 服务未注册。启动 opencode 后主机会自动连接。",
        checkedAt: Date.now(),
      })
      return
    }
    const key = `${registration.url}\u0000${registration.password}`
    try {
      const probed = await probeOpencode(registration)
      this.lastKey = key
      this.apply({ available: true, target: probed, checkedAt: Date.now() })
    } catch (error) {
      // Keep the last known target so a transient probe failure does not lose
      // the password; requests will still fail until opencode answers again.
      this.lastKey = key
      this.apply({
        available: false,
        ...(this.stateValue.target ? { target: this.stateValue.target } : { target: registration }),
        error: messageOf(error),
        checkedAt: Date.now(),
      })
    }
  }

  private async candidate(): Promise<OpencodeTarget | undefined> {
    if (this.options.url) {
      if (!this.options.password) throw new Error("opencode password is required with --opencode-url")
      return { url: normalizeUrl(this.options.url), password: this.options.password }
    }
    if (process.env.OPENCODE_SERVER_URL) {
      const password = process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD
      if (!password) throw new Error("OPENCODE_PASSWORD is required with OPENCODE_SERVER_URL")
      return { url: normalizeUrl(process.env.OPENCODE_SERVER_URL), password }
    }
    return readServiceRegistration()
  }

  private apply(next: OpencodeState): void {
    const previous = this.stateValue
    this.stateValue = next
    const changed =
      previous.available !== next.available ||
      previous.target?.url !== next.target?.url ||
      previous.target?.version !== next.target?.version
    if (!changed) return
    for (const listener of this.listeners) listener(next)
  }
}

export async function probeOpencode(target: OpencodeTarget): Promise<OpencodeTarget> {
  const response = await fetch(`${target.url}/api/info`, {
    headers: { authorization: basicAuthHeader(target.password) },
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`opencode /api/info returned HTTP ${response.status}`)
  const info = (await response.json()) as OpencodeInfo
  return { ...target, ...(info.version ? { version: info.version } : {}) }
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
}

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/u, "")
}

export async function readServiceRegistration(): Promise<OpencodeTarget | undefined> {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  const path = join(stateHome, "opencode", "service.json")
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      url?: string
      password?: string
      version?: string
    }
    if (!raw.url) return undefined
    return {
      url: normalizeUrl(raw.url),
      password: raw.password ?? process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD ?? "",
      ...(raw.version ? { version: raw.version } : {}),
    }
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
