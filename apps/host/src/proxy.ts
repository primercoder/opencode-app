import type { DeviceScope } from "./config.ts"
import { basicAuthHeader, type OpencodeTarget } from "./opencode.ts"
import { isMethodAllowed } from "./pairing.ts"

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

    sender.control({
      t: "res",
      id: request.id,
      status: response.status,
      headers: pickResponseHeaders(response.headers),
    })

    if (response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let seq = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        if (text) sender.chunk(request.id, seq++, text)
      }
      const tail = decoder.decode()
      if (tail) sender.chunk(request.id, seq++, tail)
    } else {
      const text = await response.text()
      if (text) sender.chunk(request.id, 0, text)
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
