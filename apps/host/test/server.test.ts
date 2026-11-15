import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePairingOffer } from "@ocremote/protocol"
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
    const client = await connectClient(`ws://127.0.0.1:${host.direct()!.port}/ws`, host.identity.publicKey)
    cleanups.push(() => client.close())

    const paired = await client.pair(pairCode)
    expect(paired.t).toBe("paired")
    expect(paired.device.scope).toBe("full")
    expect(typeof paired.token).toBe("string")

    const info = await client.request("GET", "/api/info")
    expect(info.status).toBe(200)
    expect(JSON.parse(info.body).version).toBe("test-2.2.7")

    const reconnect = await connectClient(`ws://127.0.0.1:${host.direct()!.port}/ws`, host.identity.publicKey)
    cleanups.push(() => reconnect.close())
    const welcome = await reconnect.auth(paired.device.id, paired.token)
    expect(welcome.t).toBe("welcome")
    expect(welcome.host.id).toBe(host.identity.hostId)
    expect(welcome.device.scope).toBe("full")
  })

  test("read-only devices can read but not write", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-host-readonly-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/api/info") return Response.json({ version: "read-only" })
        return Response.json({ created: true }, { status: 201 })
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

    const client = await connectClient(`ws://127.0.0.1:${host.direct()!.port}/ws`, host.identity.publicKey)
    cleanups.push(() => client.close())
    const paired = await client.pair(await host.issuePairCode("read"))
    expect(paired.device.scope).toBe("read")

    const info = await client.request("GET", "/api/info")
    expect(info.status).toBe(200)
    await expect(client.request("POST", "/api/session")).rejects.toThrow(/read-only/u)
  })

  test("transcribes WAV audio through asr control frames", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-host-asr-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ version: "asr-test" })
      },
    })
    cleanups.push(() => opencode.stop(true))

    let received: Uint8Array | undefined
    const host = await startHost({
      homeDir: home,
      hostname: "127.0.0.1",
      port: 0,
      opencodeUrl: `http://127.0.0.1:${opencode.port}`,
      opencodePassword: "test-password",
      asr: {
        async capabilities() {
          return { available: true, engine: "stub", models: [{ id: "stub-model", name: "Stub" }] }
        },
        async transcribe(wav) {
          received = wav
          return { text: "你好", engine: "stub", model: "stub-model", durationMs: 120, segments: [] }
        },
        close() {},
      },
    })
    cleanups.push(() => host.close())

    const client = await connectClient(`ws://127.0.0.1:${host.direct()!.port}/ws`, host.identity.publicKey)
    cleanups.push(() => client.close())
    const paired = await client.pair(await host.issuePairCode())
    expect(paired.asr.host.available).toBe(true)

    client.sendControl({ t: "asr.start", id: 99, mime: "audio/wav", durationMs: 120, language: "zh" })
    client.sendControl({ t: "asr.chunk", id: 99, data: Buffer.from([1, 2, 3, 4]).toString("base64") })
    client.sendControl({ t: "asr.end", id: 99 })

    const result = await client.receiveFor(99)
    expect(result.t).toBe("asr.result")
    expect(result.text).toBe("你好")
    expect(Array.from(received ?? [])).toEqual([1, 2, 3, 4])
  })

  test("tracks multiple clients and removes them on close", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-host-clients-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ version: "clients-test" })
      },
    })
    cleanups.push(() => opencode.stop(true))
    const host = await startHost({
      homeDir: home,
      hostname: "127.0.0.1",
      port: 0,
      opencodeUrl: `http://127.0.0.1:${opencode.port}`,
      opencodePassword: "x",
    })
    cleanups.push(() => host.close())

    const first = await connectClient(`ws://127.0.0.1:${host.direct()!.port}/ws`, host.identity.publicKey)
    cleanups.push(() => first.close())
    await first.pair(await host.issuePairCode())
    const second = await connectClient(`ws://127.0.0.1:${host.direct()!.port}/ws`, host.identity.publicKey)
    cleanups.push(() => second.close())
    await second.pair(await host.issuePairCode())

    expect(host.clients()).toHaveLength(2)
    expect(host.clients().every((client) => client.transport === "direct")).toBe(true)

    first.close()
    await Bun.sleep(100)
    expect(host.clients()).toHaveLength(1)
  })

  test("ignores a saved relay room when relay is not requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-host-direct-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ version: "direct-test" })
      },
    })
    cleanups.push(() => opencode.stop(true))
    const first = await startHost({
      homeDir: home,
      hostname: "127.0.0.1",
      port: 0,
      opencodeUrl: `http://127.0.0.1:${opencode.port}`,
      opencodePassword: "x",
    })
    await first.close()

    const configPath = join(home, "config.json")
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>
    config.relay = {
      url: "ws://127.0.0.1:1/ws",
      room: "room_stale",
      subjectId: "sub_stale",
      secret: "secret-stale",
    }
    await writeFile(configPath, JSON.stringify(config, null, 2))

    const host = await startHost({
      homeDir: home,
      hostname: "127.0.0.1",
      port: 0,
      relay: null,
      opencodeUrl: `http://127.0.0.1:${opencode.port}`,
      opencodePassword: "x",
    })
    cleanups.push(() => host.close())
    expect(host.relay()).toBeUndefined()
    // Loopback direct is alive for local tooling but is never offered to phones.
    expect(host.direct()?.hostname).toBe("127.0.0.1")
    await expect(host.pairingRoutes()).rejects.toThrow(/no phone-reachable transport/u)
  })

  test("cancels an in-flight upstream request", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocremote-host-cancel-"))
    cleanups.push(() => rm(home, { recursive: true, force: true }))

    const slowStarted = Promise.withResolvers<void>()
    const slowAborted = Promise.withResolvers<void>()
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/slow") {
          slowStarted.resolve()
          return new Promise<Response>((resolve) => {
            request.signal.addEventListener("abort", () => {
              slowAborted.resolve()
              resolve(new Response("aborted", { status: 499 }))
            })
          })
        }
        if (url.pathname === "/api/info") return Response.json({ version: "after-cancel" })
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
    const client = await connectClient(`ws://127.0.0.1:${host.direct()!.port}/ws`, host.identity.publicKey)
    cleanups.push(() => client.close())
    await client.pair(pairCode)

    client.sendControl({ t: "req", id: 77, method: "GET", path: "/api/slow", headers: {}, body: null })
    await slowStarted.promise
    client.sendControl({ t: "cancel", id: 77 })
    await slowAborted.promise

    const info = await client.request("GET", "/api/info")
    expect(JSON.parse(info.body).version).toBe("after-cancel")
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
  const receiveFor = async (id: number) => {
    while (true) {
      const value = await receiveControl()
      if (typeof value.id !== "number" || value.id === id) return value
    }
  }

  return {
    close: () => ws.close(),
    closed,
    sendControl,
    receiveFor,
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
      const response = await receiveFor(id)
      if (response.t !== "res") {
        throw new Error(`expected res, got ${String(response.t)}: ${String(response.message ?? "")}`)
      }
      let body = ""
      while (true) {
        const chunk = await receiveFor(id)
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
