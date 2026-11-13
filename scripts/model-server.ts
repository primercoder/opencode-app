/**
 * Local model server used during development. It serves the files in
 * dev-models/ with HTTP Range support so the Android emulator, a real phone,
 * and the host can exercise the same download path as release builds.
 */
import { stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import { MODEL_SPECS } from "../packages/models/src/index.ts"

const root = resolve(join(import.meta.dir, "../dev-models"))
const port = Number(process.env.MODEL_SERVER_PORT ?? 9000)
const hostname = process.env.MODEL_SERVER_HOST ?? "0.0.0.0"

const contentTypes: Record<string, string> = {
  ".bin": "application/octet-stream",
  ".bz2": "application/x-bzip2",
  ".json": "application/json",
  ".wav": "audio/wav",
}

Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") return new Response("ok\n")
    if (url.pathname === "/catalog.json") {
      return Response.json(
        {
          models: MODEL_SPECS.map((spec) => ({
            ...spec,
            devUrl: `/models/${spec.devPath}`,
          })),
        },
        { headers: cors() },
      )
    }

    if (!url.pathname.startsWith("/models/")) return new Response("not found", { status: 404, headers: cors() })
    const relative = normalize(decodeURIComponent(url.pathname.slice("/models/".length)))
    if (relative.startsWith("..") || relative.includes("\0")) return new Response("bad path", { status: 400, headers: cors() })
    const path = resolve(join(root, relative))
    if (!path.startsWith(root)) return new Response("bad path", { status: 400, headers: cors() })

    try {
      const info = await stat(path)
      if (!info.isFile()) return new Response("not found", { status: 404, headers: cors() })
      const file = Bun.file(path)
      const type = contentTypes[extname(path)] ?? "application/octet-stream"
      const range = request.headers.get("range")
      if (!range) {
        return new Response(file, {
          headers: {
            ...cors(),
            "content-type": type,
            "content-length": String(info.size),
            "accept-ranges": "bytes",
          },
        })
      }

      const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim())
      if (!match) return new Response("bad range", { status: 416, headers: cors() })
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Number(match[2]) : info.size - 1
      if (start > end || start >= info.size) {
        return new Response("bad range", { status: 416, headers: { ...cors(), "content-range": `bytes */${info.size}` } })
      }
      const boundedEnd = Math.min(end, info.size - 1)
      return new Response(file.slice(start, boundedEnd + 1), {
        status: 206,
        headers: {
          ...cors(),
          "content-type": type,
          "content-length": String(boundedEnd - start + 1),
          "content-range": `bytes ${start}-${boundedEnd}/${info.size}`,
          "accept-ranges": "bytes",
        },
      })
    } catch {
      return new Response("not found", { status: 404, headers: cors() })
    }
  },
})

console.log(`model server listening on http://${hostname}:${port}/models (root ${root})`)

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "range,content-type",
    "access-control-expose-headers": "content-length,content-range,accept-ranges",
  }
}
