import type { HostRuntime } from "@/transport/hostRuntime"

export type SessionInfo = {
  id: string
  parentID?: string
  projectID?: string
  title?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  time?: { created?: number | string; updated?: number | string; busy?: number | string; idle?: number | string }
  outcome?: string
  location?: { directory?: string; workspaceID?: string }
}

export type Page<T> = {
  data: T[]
  cursor?: string
}

export type ServerInfo = {
  version?: string
  hostname?: string
  urls?: string[]
}

export type SessionMessage = {
  id: string
  type: string
  text?: string
  content?: AssistantContent[]
  time?: { created?: number | string; completed?: number | string }
  agent?: string
  model?: unknown
  error?: { message?: string }
  outcome?: string
  description?: string
  name?: string
}

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool"
      id: string
      name: string
      state?: { status?: string; input?: unknown; error?: { message?: string } }
      time?: { created?: number | string; completed?: number | string }
    }
  | { type: string; [key: string]: unknown }

export class OpencodeClient {
  constructor(private readonly runtime: HostRuntime) {}

  async info(): Promise<ServerInfo> {
    return this.raw<ServerInfo>("GET", "/api/info")
  }

  async listSessions(input: { limit?: number; order?: "asc" | "desc"; search?: string } = {}): Promise<Page<SessionInfo>> {
    const params = new URLSearchParams()
    params.set("limit", String(input.limit ?? 50))
    params.set("order", input.order ?? "desc")
    if (input.search) params.set("search", input.search)
    return this.raw<Page<SessionInfo>>("GET", `/api/session?${params.toString()}`)
  }

  async createSession(input: { title?: string; agent?: string } = {}): Promise<SessionInfo> {
    const result = await this.raw<{ data: SessionInfo }>("POST", "/api/session", input)
    return result.data
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    const result = await this.raw<{ data: SessionInfo }>("GET", `/api/session/${encodeURIComponent(sessionId)}`)
    return result.data
  }

  async listMessages(sessionId: string, input: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {}): Promise<Page<SessionMessage>> {
    const params = new URLSearchParams()
    params.set("limit", String(input.limit ?? 50))
    params.set("order", input.order ?? "asc")
    if (input.cursor) params.set("cursor", input.cursor)
    return this.raw<Page<SessionMessage>>("GET", `/api/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`)
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text })
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`)
  }

  private async raw<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.runtime.request({
      method,
      path,
      headers: {
        accept: "application/json",
        "x-opencode-capabilities": "experimental-media-uri",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`opencode ${method} ${path} returned HTTP ${response.status}`)
    }
    if (!response.body) return undefined as T
    return JSON.parse(response.body) as T
  }
}

export function sessionUpdatedAt(session: SessionInfo): number {
  return toMillis(session.time?.updated ?? session.time?.created)
}

export function sessionBusy(session: SessionInfo): boolean {
  const busy = toMillis(session.time?.busy)
  const idle = toMillis(session.time?.idle)
  return busy > 0 && busy >= idle
}

export function toMillis(value: number | string | undefined): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}
