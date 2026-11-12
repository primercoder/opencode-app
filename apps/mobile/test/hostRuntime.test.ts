import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base64UrlEncode, type PairingOffer } from "@ocremote/protocol"
import { startHost } from "../../host/src/server.ts"
import { HostEventStream } from "../src/transport/hostEvents.ts"
import { HostRuntime } from "../src/transport/hostRuntime.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ocremote-mobile-"))
  cleanups.push(() => rm(home, { recursive: true, force: true }))

  const opencode = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") {
        return Response.json({ version: "test-2.2.7", hostname: "test-host", urls: [] })
      }
      if (url.pathname === "/api/event") {
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: message\ndata: {"type":"server.connected"}\n\n'))
            controller.enqueue(encoder.encode('event: message\ndata: {"type":"session.updated"}\n\n'))
            controller.close()
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
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

  return {
    host,
    wsUrl: `ws://127.0.0.1:${host.port}/ws`,
    publicKey: base64UrlEncode(host.identity.publicKey),
  }
}

function offerFor(input: { hostId: string; name: string; publicKey: string; code: string; wsUrl: string }): PairingOffer {
  return {
    v: 1,
    hostId: input.hostId,
    name: input.name,
    pk: input.publicKey,
    fingerprint: "0000000000000000",
    pairCode: input.code,
    expiresAt: Date.now() + 60_000,
    transports: [{ kind: "lan", url: input.wsUrl, priority: 0 }],
  }
}

describe("HostRuntime", () => {
  test("pairs, exposes host info, and proxies requests", async () => {
    const env = await setup()
    const code = await env.host.issuePairCode()
    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      pairCode: code,
      device: { name: "Test phone", platform: "android", appVersion: "0.0.0" },
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())

    const session = await runtime.connect()
    expect(runtime.state).toBe("ready")
    expect(session.host.id).toBe(env.host.identity.hostId)
    expect(session.opencode.version).toBe("test-2.2.7")
    expect(session.device?.id).toStartWith("dev_")
    expect(session.token).toBeTruthy()

    const response = await runtime.request({ method: "GET", path: "/api/info" })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).version).toBe("test-2.2.7")

    expect(runtime.credentials).toEqual({
      deviceId: session.device?.id,
      token: session.token,
    })
  })

  test("authenticates with a saved device token", async () => {
    const env = await setup()
    const code = await env.host.issuePairCode()
    const first = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      pairCode: code,
      autoReconnect: false,
    })
    const paired = await first.connect()
    first.disconnect()

    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      deviceId: paired.device?.id,
      token: paired.token,
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())

    const session = await runtime.connect()
    expect(runtime.state).toBe("ready")
    expect(session.host.name).toBe(env.host.config.name)
    expect(session.device?.scope).toBe("full")
  })

  test("reports an auth error for a revoked token", async () => {
    const env = await setup()
    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      deviceId: "dev_missing",
      token: "not-a-token",
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())

    await expect(runtime.connect()).rejects.toMatchObject({ kind: "auth" })
    expect(runtime.state).toBe("error")
  })

  test("streams an SSE response with onChunk", async () => {
    const env = await setup()
    const code = await env.host.issuePairCode()
    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      pairCode: code,
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())
    await runtime.connect()

    const chunks: string[] = []
    await runtime.stream({
      method: "GET",
      path: "/api/event",
      headers: { accept: "text/event-stream" },
      onChunk: (text) => chunks.push(text),
    })

    expect(chunks.join("")).toContain("server.connected")
    expect(chunks.join("")).toContain("session.updated")
  })

  test("fails over to the next candidate", async () => {
    const env = await setup()
    const code = await env.host.issuePairCode()
    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: ["ws://127.0.0.1:1/ws", env.wsUrl],
      pairCode: code,
      autoReconnect: false,
      connectTimeoutMs: 500,
    })
    cleanups.push(() => runtime.disconnect())

    const session = await runtime.connect()
    expect(runtime.activeCandidate).toBe(env.wsUrl)
    expect(session.host.id).toBe(env.host.identity.hostId)
  })

  test("rejects pending requests when disconnected", async () => {
    const env = await setup()
    const code = await env.host.issuePairCode()
    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      pairCode: code,
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())
    await runtime.connect()

    const pending = runtime.request({ method: "GET", path: "/api/event", timeoutMs: 5_000 })
    runtime.disconnect()

    await expect(pending).rejects.toMatchObject({ kind: "network" })
  })

  test("warns when the pairing code is invalid", async () => {
    const env = await setup()
    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      pairCode: "AAAA-AAAA",
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())

    await expect(runtime.connect()).rejects.toMatchObject({ code: "PAIR_CODE_INVALID" })
    expect(runtime.state).toBe("error")
  })

  test("fans out opencode SSE events", async () => {
    const env = await setup()
    const code = await env.host.issuePairCode()
    const runtime = new HostRuntime({
      hostId: env.host.identity.hostId,
      hostPublicKey: env.publicKey,
      candidates: [env.wsUrl],
      pairCode: code,
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())
    await runtime.connect()

    const events: string[] = []
    const stream = new HostEventStream(runtime)
    cleanups.push(() => stream.stop())
    stream.subscribe((event) => {
      if (typeof event.type === "string") events.push(event.type)
    })
    stream.start()

    for (let attempt = 0; attempt < 50 && events.length < 2; attempt += 1) await Bun.sleep(50)
    expect(events).toContain("server.connected")
    expect(events).toContain("session.updated")
  })

  test("builds a host record from a pairing offer", async () => {
    const env = await setup()
    const code = await env.host.issuePairCode()
    const offer = offerFor({
      hostId: env.host.identity.hostId,
      name: "Test host",
      publicKey: env.publicKey,
      code,
      wsUrl: env.wsUrl,
    })
    const runtime = HostRuntime.fromPairingOffer(offer, {
      device: { name: "Test phone", platform: "android", appVersion: "0.0.0" },
      autoReconnect: false,
    })
    cleanups.push(() => runtime.disconnect())

    const session = await runtime.connect()
    expect(runtime.hostId).toBe(offer.hostId)
    expect(session.host.name).toBe(env.host.config.name)
  })
})
