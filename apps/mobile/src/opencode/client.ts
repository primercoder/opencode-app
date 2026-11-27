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

export type PageCursor = {
  previous?: string
  next?: string
}

export type Page<T> = {
  data: T[]
  cursor?: PageCursor
}

export type BackgroundJob = {
  id: string
  kind: string
  status: string
  title?: string
  time?: { started?: number }
  shellID?: string
  command?: string
  childSessionID?: string
  description?: string
  agent?: string
  path?: string
}

export type ServerInfo = {
  version?: string
  hostname?: string
  urls?: string[]
}

export type HostRuntimeInfo = {
  home: string
  opencode: {
    available: boolean
    version?: string
    baseUrl?: string
    error?: string
  }
}

export type DirectoryEntry = {
  name: string
  path: string
  /** Path relative to the browse root, e.g. "code/app". Empty at the root. */
  relative: string
}

export type DirectoryListing = {
  home: string
  path: string
  relative: string
  entries: DirectoryEntry[]
}

export type DirectoryCheck = {
  valid: boolean
  directory: boolean
  path?: string
  relative?: string
  error?: string
}

export type ProjectInfo = {
  id: string
  canonical: string
  name?: string
  icon?: { color?: string; image?: string }
  time?: { created?: number | string; updated?: number | string }
}

export type AgentInfo = {
  id: string
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  color?: string
  model?: { id: string; providerID: string; variant?: string }
}

export type ModelInfo = {
  id: string
  modelID: string
  providerID: string
  name: string
  status: string
  enabled: boolean
  variants?: { id: string }[]
  limit?: { context: number; output: number }
  cost?: { input: number; output: number }[]
}

export type SkillInfo = {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path?: string
  content?: string
}

export type InboxItem = {
  id: string
  sessionID?: string
  type: string
  delivery?: "queue" | "steer"
  time?: { created?: number | string }
  payload?: { text?: string }
}

export type McpServer = {
  name: string
  title?: string
  status?: { status: string; error?: string }
}

export type CommandInfo = {
  name: string
  description?: string
}

export type FsEntry = {
  path: string
  type: "file" | "directory"
  ignored?: boolean
  /** Host-classified preview metadata (older hosts omit these). */
  kind?: string
  previewable?: boolean
  language?: string
}

export type FileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export type PermissionRequest = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type: "tool"; messageID: string; id: string }
  message?: string
}

export type FormOption = {
  value: string
  label: string
  description?: string
}

export type FormWhen = {
  key: string
  op: "eq" | "neq"
  value: string | number | boolean
}

export type FormValue = string | number | boolean | string[]

export type FormField = {
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  key: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  when?: FormWhen[]
  default?: FormValue
  options?: FormOption[]
  placeholder?: string
  format?: string
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  custom?: boolean
  url?: string
}

export type FormInfo = {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: FormField[]
}

export type SessionMessage = {
  id: string
  type: string
  text?: string
  content?: AssistantContent[]
  time?: { created?: number | string; completed?: number | string }
  agent?: string
  model?: { id?: string; providerID?: string; variant?: string }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  error?: { message?: string }
  outcome?: string
  description?: string
  name?: string
  status?: string
  command?: string
  shellID?: string
  exit?: number
  output?: { output?: string; cursor?: number; size?: number; truncated?: boolean }
  summary?: string
  reason?: "manual" | "auto"
  metadata?: Record<string, unknown>
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

export class OpencodeClient {
  constructor(private readonly runtime: HostRuntime) {}

  async info(): Promise<ServerInfo> {
    return this.raw<ServerInfo>("GET", "/api/info")
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return this.raw<ProjectInfo[]>("GET", "/api/project?archived=false")
  }

  async listAgents(directory?: string): Promise<AgentInfo[]> {
    const result = await this.raw<{ data: AgentInfo[] }>("GET", withDirectory("/api/agent", directory))
    return result.data
  }

  async listModels(directory?: string): Promise<ModelInfo[]> {
    const result = await this.raw<{ data: ModelInfo[] }>("GET", withDirectory("/api/model?types=chat", directory))
    return result.data.filter((model) => model.enabled !== false && (model.status === undefined || model.status !== "deprecated"))
  }

  async getDefaultModel(directory?: string): Promise<ModelInfo> {
    const result = await this.raw<{ data: ModelInfo }>("GET", withDirectory("/api/model/default", directory))
    return result.data
  }

  async switchAgent(sessionId: string, agent: string): Promise<void> {
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/agent`, { agent })
  }

  async switchModel(sessionId: string, model: { id: string; providerID: string; variant?: string }): Promise<void> {
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/model`, { model })
  }

  async listMcp(directory?: string): Promise<McpServer[]> {
    const result = await this.raw<{ data: McpServer[] }>("GET", withDirectory("/api/mcp", directory))
    return result.data
  }

  async setMcpConnected(name: string, connected: boolean, directory?: string): Promise<void> {
    const action = connected ? "connect" : "disconnect"
    const path = withDirectory(`/api/experimental/mcp/${encodeURIComponent(name)}/${action}`, directory)
    await this.raw<unknown>("POST", path)
  }

  async listSessions(
    input: { limit?: number; order?: "asc" | "desc"; search?: string; parentID?: string } = {},
  ): Promise<Page<SessionInfo>> {
    const params = new URLSearchParams()
    params.set("limit", String(input.limit ?? 50))
    params.set("order", input.order ?? "desc")
    if (input.search) params.set("search", input.search)
    if (input.parentID) params.set("parentID", input.parentID)
    return this.raw<Page<SessionInfo>>("GET", `/api/session?${params.toString()}`)
  }

  async listSkills(directory?: string): Promise<SkillInfo[]> {
    const result = await this.raw<{ data: SkillInfo[] }>("GET", withDirectory("/api/skill", directory))
    return result.data
  }

  async listCommands(directory?: string): Promise<CommandInfo[]> {
    const result = await this.raw<{ data: CommandInfo[] }>("GET", withDirectory("/api/command", directory))
    return result.data
  }

  async runCommand(sessionId: string, name: string, text = ""): Promise<void> {
    // OpenCode 2 requires `text` even when the command has no arguments.
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/command`, {
      name,
      text,
    })
  }

  async runShell(sessionId: string, command: string): Promise<void> {
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/shell`, { command })
  }

  async listRunningShells(directory: string): Promise<Array<{ id: string }>> {
    const result = await this.raw<{ data: Array<{ id: string }> }>("GET", withDirectory("/api/shell", directory))
    return result.data
  }

  async stopShell(shellId: string, directory: string): Promise<void> {
    const path = withDirectory(`/api/shell/${encodeURIComponent(shellId)}`, directory)
    await this.raw("DELETE", path)
  }

  async listRunningJobs(sessionId: string): Promise<BackgroundJob[]> {
    const params = new URLSearchParams({ sessionID: sessionId, status: "running", descendants: "true" })
    const result = await this.raw<{ data: BackgroundJob[] }>("GET", `/api/experimental/job?${params}`)
    return result.data
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.raw("POST", `/api/experimental/job/${encodeURIComponent(jobId)}/cancel`)
  }

  async compactSession(sessionId: string): Promise<void> {
    // The route requires an object payload even though every field is optional.
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/compact`, {})
  }

  async listInbox(sessionId: string): Promise<InboxItem[]> {
    const result = await this.raw<{ data: InboxItem[] }>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/inbox`,
    )
    return result.data
  }

  async cancelInbox(sessionId: string, inboxId: string): Promise<void> {
    await this.raw<unknown>(
      "DELETE",
      `/api/session/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
    )
  }

  async createSession(input: { title?: string; agent?: string; location?: { directory: string } } = {}): Promise<SessionInfo> {
    const result = await this.raw<{ data: SessionInfo }>("POST", "/api/session", input)
    return result.data
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    const result = await this.raw<{ data: SessionInfo }>("GET", `/api/session/${encodeURIComponent(sessionId)}`)
    return result.data
  }

  async listMessages(
    sessionId: string,
    input: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {},
  ): Promise<Page<SessionMessage>> {
    const params = new URLSearchParams()
    params.set("limit", String(input.limit ?? 50))
    // The server rejects cursor + order; the cursor already carries the order.
    if (input.cursor) params.set("cursor", input.cursor)
    else params.set("order", input.order ?? "asc")
    return this.raw<Page<SessionMessage>>("GET", `/api/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`)
  }

  async listFiles(directory: string, path?: string): Promise<FsEntry[]> {
    const params = new URLSearchParams()
    params.set("location[directory]", directory)
    if (path) params.set("path", path)
    const result = await this.raw<{ data: FsEntry[] }>("GET", `/api/fs/list?${params.toString()}`)
    return result.data
  }

  /**
   * Host-served runtime info. Unlike `/api/info` this works while opencode is
   * not running, so the workspace can tell "host offline" from "opencode
   * offline".
   */
  async hostRuntime(): Promise<HostRuntimeInfo> {
    return this.raw<HostRuntimeInfo>("GET", "/host/runtime")
  }

  /** Lists directories under the browse root (the home directory). */
  async listDirectories(path?: string): Promise<DirectoryListing> {
    const query = path ? `?path=${encodeURIComponent(path)}` : ""
    return this.raw<DirectoryListing>("GET", `/host/dirs${query}`)
  }

  /** Validates a typed directory without creating anything. */
  async checkDirectory(path: string): Promise<DirectoryCheck> {
    return this.raw<DirectoryCheck>("GET", `/host/dirs/check?path=${encodeURIComponent(path)}`)
  }

  async readFile(
    directory: string,
    path: string,
  ): Promise<{
    content: string
    contentType: string | undefined
    kind?: string
    previewable?: boolean
    language?: string
  }> {
    const encoded = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")
    const response = await this.runtime.request({
      method: "GET",
      path: `/api/fs/read/${encoded}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      headers: { accept: "*/*", "x-opencode-capabilities": "experimental-media-uri" },
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`opencode read ${path} returned HTTP ${response.status}`)
    }
    return {
      content: response.body,
      contentType: response.headers["content-type"],
      ...(response.headers["x-ocremote-file-kind"] ? { kind: response.headers["x-ocremote-file-kind"] } : {}),
      ...(response.headers["x-ocremote-previewable"]
        ? { previewable: response.headers["x-ocremote-previewable"] === "true" }
        : {}),
      ...(response.headers["x-ocremote-language"] ? { language: response.headers["x-ocremote-language"] } : {}),
    }
  }

  async sessionDiff(sessionId: string): Promise<FileDiff[]> {
    const result = await this.raw<{ data: FileDiff[] }>("GET", `/api/session/${encodeURIComponent(sessionId)}/diff`)
    return result.data
  }

  async listPermissions(sessionId: string): Promise<PermissionRequest[]> {
    const result = await this.raw<{ data: PermissionRequest[] }>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/permission`,
    )
    return result.data
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ): Promise<void> {
    await this.raw<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { decision, ...(message ? { message } : {}) },
    )
  }

  async listForms(sessionId: string): Promise<FormInfo[]> {
    const result = await this.raw<{ data: FormInfo[] }>("GET", `/api/session/${encodeURIComponent(sessionId)}/form`)
    return result.data
  }

  async replyForm(sessionId: string, formId: string, answer: Record<string, FormValue>): Promise<void> {
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`, {
      answer,
    })
  }

  async cancelForm(sessionId: string, formId: string, message?: string): Promise<void> {
    const query = message ? `?message=${encodeURIComponent(message)}` : ""
    await this.raw<unknown>(
      "DELETE",
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}${query}`,
    )
  }

  async prompt(sessionId: string, input: string | {
    text: string
    files?: Array<{ uri: string; mime: string; name?: string }>
    skills?: Array<{ id: string; mention?: { start: number; end: number; text: string } }>
    metadata?: Record<string, unknown>
    delivery?: "queue" | "steer"
  }): Promise<void> {
    const body = typeof input === "string" ? { text: input } : input
    await this.raw<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, body)
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
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(apiError(method, path, response.status, response.body))
    }
    if (!response.body) return undefined as T
    return JSON.parse(response.body) as T
  }
}

/**
 * OpenCode returns `{ message, _tag, error: { message } }` for API failures.
 * Prefer the server message so the UI can show "Command not found: x" instead
 * of a long request path.
 */
function apiError(method: string, path: string, status: number, body: string): string {
  let detail: string | undefined
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown
      error?: { message?: unknown } | string
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) detail = parsed.message
    else if (typeof parsed.error === "string") detail = parsed.error
    else if (
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      typeof parsed.error.message === "string"
    ) {
      detail = parsed.error.message
    }
  } catch {
    // Non-JSON bodies fall back to the HTTP status.
  }
  const clean = detail?.replace(/\s+/gu, " ").trim()
  return clean
    ? `opencode ${method} ${path} returned HTTP ${status}: ${clean}`
    : `opencode ${method} ${path} returned HTTP ${status}`
}

function withDirectory(path: string, directory: string | undefined): string {
  if (!directory) return path
  const separator = path.includes("?") ? "&" : "?"
  return `${path}${separator}location%5Bdirectory%5D=${encodeURIComponent(directory)}`
}

export function sessionUpdatedAt(session: SessionInfo): number {
  return toMillis(session.time?.updated ?? session.time?.created)
}

export function sessionBusy(session: SessionInfo): boolean {
  // Pure timestamp check, matching opencode's own view: busy wins while it is
  // not older than idle. A stored `outcome` must NOT short-circuit this —
  // opencode keeps the previous turn's outcome ("succeeded") on the session
  // when a new turn starts, so outcome-first logic marked every session that
  // had ever finished a turn as idle, breaking busy state for any session
  // that was already running before the phone connected.
  const busy = toMillis(session.time?.busy)
  const idle = toMillis(session.time?.idle)
  return busy > 0 && busy >= idle
}

const FINAL_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "interrupted", "error"])

export function toMillis(value: number | string | undefined): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}
