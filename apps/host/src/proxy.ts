import type { DeviceScope } from "./config.ts"
import { basicAuthHeader, type OpencodeTarget } from "./opencode.ts"
import { isMethodAllowed } from "./pairing.ts"
import { classifyFile, looksBinary } from "./fileKind.ts"

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "x-opencode-directory",
  "x-opencode-capabilities",
  "if-none-match",
  "range",
])
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "etag",
  "cache-control",
  "last-modified",
])
const MAX_BODY_BYTES = 20 * 1024 * 1024
const JSON_TIMEOUT_MS = 30_000
const STREAM_TIMEOUT_MS = 30 * 60_000

export type ProxyRequest = {
  id: number
  method: string
  path: string
  headers?: Record<string, string>
  body?: string | null
}

export type ProxySender = {
  control(value: { t: string; [key: string]: unknown }): void
  chunk(id: number, seq: number, data: string): void
}

export async function handleProxyRequest(input: {
  request: ProxyRequest
  target: OpencodeTarget
  scope: DeviceScope
  sender: ProxySender
  signal?: AbortSignal
}): Promise<void> {
  const { request, target, scope, sender } = input
  const method = request.method.toUpperCase()
  try {
    if (!ALLOWED_METHODS.has(method)) throw new ProxyError("BAD_REQUEST", "method not allowed")
    if (!isMethodAllowed(scope, method)) throw new ProxyError("FORBIDDEN", "device is read-only")
    if (!request.path.startsWith("/api/") || request.path.includes("..")) {
      throw new ProxyError("BAD_REQUEST", "only /api paths are allowed")
    }
    if (request.body && Buffer.byteLength(request.body, "utf8") > MAX_BODY_BYTES) {
      throw new ProxyError("TOO_LARGE", "request body exceeds 20 MiB")
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (ALLOWED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
    }
    headers.set("authorization", basicAuthHeader(target.password))

    const streaming = method === "GET" && request.path.startsWith("/api/event")
    const response = await fetch(`${target.url}${request.path}`, {
      method,
      headers,
      ...(request.body !== undefined && request.body !== null ? { body: request.body } : {}),
      redirect: "manual",
      signal: AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(streaming ? STREAM_TIMEOUT_MS : JSON_TIMEOUT_MS),
      ]),
    })

    const fsList = method === "GET" && request.path.startsWith("/api/fs/list")
    const fsRead = method === "GET" && request.path.startsWith("/api/fs/read/")
    let seq = 0
    // OCRP frames are capped at 1 MiB. Split strings so a large diff or file
    // body cannot turn into a single oversized protected record.
    const emit = (text: string) => {
      if (!text) return
      for (let offset = 0; offset < text.length; offset += 32_000) {
        sender.chunk(request.id, seq++, text.slice(offset, offset + 32_000))
      }
    }

    // File browser requests carry host-side type metadata so the phone never
    // has to download a binary file just to discover that it cannot preview it.
    if (fsList || fsRead) {
      const body = await response.text()
      const headers = pickResponseHeaders(response.headers)
      let output = body
      if (fsList && response.ok) {
        output = enrichFileList(body)
      } else if (fsRead && response.ok) {
        const info = classifyRead(request.path, body, response.headers.get("content-type") ?? undefined)
        headers["x-ocremote-file-kind"] = info.kind
        headers["x-ocremote-previewable"] = String(info.previewable)
        if (info.language) headers["x-ocremote-language"] = info.language
      }
      sender.control({ t: "res", id: request.id, status: response.status, headers })
      emit(output)
      sender.control({ t: "end", id: request.id })
      return
    }

    sender.control({
      t: "res",
      id: request.id,
      status: response.status,
      headers: pickResponseHeaders(response.headers),
    })

    if (response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        emit(decoder.decode(value, { stream: true }))
      }
      emit(decoder.decode())
    } else {
      emit(await response.text())
    }
    sender.control({ t: "end", id: request.id })
  } catch (error) {
    const failure =
      error instanceof ProxyError
        ? error
        : new ProxyError("UPSTREAM_ERROR", error instanceof Error ? error.message : "proxy request failed")
    sender.control({ t: "err", id: request.id, code: failure.code, message: failure.message })
  }
}

export class ProxyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ProxyError"
  }
}

function pickResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) result[key.toLowerCase()] = value
  })
  return result
}

function enrichFileList(body: string): string {
  try {
    const payload = JSON.parse(body) as { data?: Array<{ path?: unknown; type?: unknown }> }
    if (!Array.isArray(payload.data)) return body
    payload.data = payload.data.map((entry) => {
      const path = typeof entry.path === "string" ? entry.path : ""
      const type = entry.type === "directory" ? "directory" : "file"
      return { ...entry, ...classifyFile(path, type) }
    })
    return JSON.stringify(payload)
  } catch {
    return body
  }
}

function classifyRead(path: string, body: string, contentType: string | undefined) {
  const raw = path.slice("/api/fs/read/".length).split("?")[0] ?? ""
  let filePath = raw
  try {
    filePath = raw.split("/").map(decodeURIComponent).join("/")
  } catch {
    // keep the encoded path; extension detection still works in most cases
  }
  const info = classifyFile(filePath)
  if (info.kind !== "unknown") return info
  if (looksBinary(body, contentType)) return { kind: "binary" as const, previewable: false }
  return { kind: "text" as const, previewable: true }
}
