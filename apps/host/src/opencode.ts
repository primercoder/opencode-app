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

const INFO_TIMEOUT_MS = 5_000

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

async function readServiceRegistration(): Promise<OpencodeTarget | undefined> {
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
