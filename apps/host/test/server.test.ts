import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  base64UrlDecode,
  base64UrlEncode,
  createNoiseInitiator,
  decodeFrame,
  decodeProtectedRecord,
  encodeFrame,
  encodeProtectedRecord,
} from "@ocremote/protocol"
import { startHost } from "../src/server.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe("host LAN server", () => {
  test("pairs a device, then proxies /api/info over encrypted OCRP", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-host-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))

    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/info") {
          return Response.json({ version: "test-2.2.7", hostname: "test-host", urls: [], paths: { tmp: "/tmp" } })
        }
        return new Response("not found", { status: 404 })
      },
    })
    cleanups.push(() => opencode.stop(true))

    const host = await startHost({
      homeDir: home,
      hostname: "127.0.0.1",
      port: 0,
      opencodeUrl: `http://127.0.0.1:${opencode.port}`,
      opencodePassword: "test-password",
    })
    cleanups.push(() => host.close())

    const pairCode = await host.issuePairCode()
    const client = await connectClient(`ws://127.0.0.1:${host.port}/ws`, host.identity.publicKey)
    cleanups.push(() => client.close())

    const paired = await client.pair(pairCode)
    expect(paired.t).toBe("paired")
    expect(paired.device.scope).toBe("full")
    expect(typeof paired.token).toBe("string")

    const info = await client.request("GET", "/api/info")
    expect(info.status).toBe(200)
    expect(JSON.parse(info.body).version).toBe("test-2.2.7")

    const reconnect = await connectClient(`ws://127.0.0.1:${host.port}/ws`, host.identity.publicKey)
    cleanups.push(() => reconnect.close())
    const welcome = await reconnect.auth(paired.device.id, paired.token)
    expect(welcome.t).toBe("welcome")
    expect(welcome.host.id).toBe(host.identity.hostId)
  })
})

type Client = Awaited<ReturnType<typeof connectClient>>

async function connectClient(url: string, hostPublicKey: Uint8Array) {
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"
  let closeResolve: (value: unknown) => void = () => undefined
  const closed = new Promise((resolve) => {
    closeResolve = resolve
  })
  cleanups.push(() => ws.close())

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("websocket open failed"))
  })

  const queue: Array<string | Uint8Array> = []
  const waiters: Array<(value: string | Uint8Array) => void> = []
  ws.onmessage = (event) => {
    const value = typeof event.data === "string" ? event.data : new Uint8Array(event.data)
    const waiter = waiters.shift()
    if (waiter) waiter(value)
    else queue.push(value)
  }
  ws.onclose = () => closeResolve(undefined)

  const next = async (): Promise<string | Uint8Array> => {
    const value = queue.shift()
    if (value !== undefined) return value
    return await new Promise((resolve) => waiters.push(resolve))
  }

  const initiator = createNoiseInitiator({
    remoteStatic: hostPublicKey,
    prologue: new TextEncoder().encode("ocremote/1"),
  })
  const message1 = initiator.writeMessage(new Uint8Array())
  ws.send(JSON.stringify({ t: "noise", message: base64UrlEncode(message1) }))
  const response = await next()
  if (typeof response !== "string") throw new Error("expected noise text response")
  const parsed = JSON.parse(response) as { t: string; message: string }
  initiator.readMessage(base64UrlDecode(parsed.message))
  const keys = initiator.split()

  let requestId = 1
  const sendControl = (value: Record<string, unknown>) => {
    const frame = encodeFrame({ kind: "control", streamId: 0, value: value as { t: string } })
    ws.send(encodeProtectedRecord("binary", frame, keys.send))
  }
  const receiveControl = async () => {
    const data = await next()
    if (typeof data === "string") throw new Error("expected binary protected record")
    const record = decodeProtectedRecord(data, keys.receive)
    const frame = decodeFrame(record.data)
    if (frame.kind !== "control") throw new Error("expected control frame")
    return frame.value
  }

  return {
    close: () => ws.close(),
    closed,
    async pair(code: string) {
      sendControl({
        t: "hello",
        v: 1,
        device: { id: "dev_client", name: "Test Client", platform: "android", appVersion: "0.0.0" },
        pair: { code, requestedScope: "full" },
        caps: ["binary", "sse"],
      })
      return (await receiveControl()) as Record<string, any>
    },
    async auth(deviceId: string, token: string) {
      sendControl({
        t: "hello",
        v: 1,
        device: { id: deviceId, name: "Test Client", platform: "android", appVersion: "0.0.0" },
        auth: { deviceId, token },
        caps: ["binary", "sse"],
      })
      return (await receiveControl()) as Record<string, any>
    },
    async request(method: string, path: string) {
      const id = requestId++
      sendControl({ t: "req", id, method, path, headers: {}, body: null })
      const response = await receiveControl()
      if (response.t !== "res") throw new Error(`expected res, got ${String(response.t)}`)
      let body = ""
      while (true) {
        const chunk = await receiveControl()
        if (chunk.t === "chunk") {
          body += String(chunk.data)
          continue
        }
        if (chunk.t === "end") break
        if (chunk.t === "err") throw new Error(String(chunk.message))
        throw new Error(`unexpected frame ${String(chunk.t)}`)
      }
      return { status: response.status as number, body }
    },
  }
}
