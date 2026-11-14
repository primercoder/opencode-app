import { describe, expect, test } from "bun:test"
import { SessionStreamController } from "../src/features/session/streamController.ts"

function event(type: string, data: Record<string, unknown>, created = 1) {
  return { type, data, created }
}

describe("session stream presentation", () => {
  test("buffers text and drains it gradually", async () => {
    const controller = new SessionStreamController()
    controller.ingest(event("session.step.started", { assistantMessageID: "m1" }))
    controller.ingest(event("session.text.delta", { assistantMessageID: "m1", delta: "x".repeat(300) }))
    await Bun.sleep(80)
    expect(controller.pump(Date.now())).toBe(true)
    const first = controller.snapshot()[0]?.content?.find((block) => block.type === "text")
    expect(first && first.type === "text" ? first.text.length : 0).toBeGreaterThan(0)
    expect(first && first.type === "text" ? first.text.length : 0).toBeLessThan(300)

    for (let index = 0; index < 80; index += 1) controller.pump(Date.now() + index * 100)
    const full = controller.snapshot()[0]?.content?.find((block) => block.type === "text")
    expect(full && full.type === "text" ? full.text.length : 0).toBe(300)
  })

  test("keeps reasoning and text in separate segments", async () => {
    const controller = new SessionStreamController()
    controller.ingest(event("session.reasoning.started", { assistantMessageID: "m2" }))
    controller.ingest(event("session.reasoning.delta", { assistantMessageID: "m2", delta: "thinking ".repeat(10) }))
    controller.ingest(event("session.text.started", { assistantMessageID: "m2" }))
    controller.ingest(event("session.text.delta", { assistantMessageID: "m2", delta: "answer" }))
    await Bun.sleep(80)
    controller.pump(Date.now())
    const content = controller.snapshot()[0]?.content ?? []
    expect(content.some((block) => block.type === "reasoning")).toBe(true)
    expect(content.some((block) => block.type === "text")).toBe(true)
  })

  test("ignores events from other sessions", async () => {
    const controller = new SessionStreamController()
    controller.setSession("ses_a")
    controller.ingest(event("session.text.delta", { sessionID: "ses_b", assistantMessageID: "m4", delta: "other" }))
    controller.ingest(event("session.text.delta", { sessionID: "ses_a", assistantMessageID: "m5", delta: "mine" }))
    controller.pump(Date.now())
    expect(controller.snapshot().map((message) => message.id)).toEqual(["m5"])
  })

  test("stops the streaming caret when the text block ends", () => {
    const controller = new SessionStreamController()
    controller.ingest(event("session.text.started", { assistantMessageID: "m6" }))
    controller.ingest(event("session.text.delta", { assistantMessageID: "m6", delta: "done" }))
    controller.pump(Date.now())
    expect(controller.snapshot()[0]?.metadata?.streaming).toBe(true)

    controller.ingest(event("session.text.ended", { assistantMessageID: "m6", text: "done" }))
    expect(controller.snapshot()[0]?.metadata?.streaming).toBe(false)
  })

  test("stops the streaming caret as soon as the execution ends", () => {
    const controller = new SessionStreamController()
    controller.ingest(event("session.text.started", { assistantMessageID: "m7" }))
    controller.ingest(event("session.text.delta", { assistantMessageID: "m7", delta: "partial" }))
    controller.pump(Date.now())
    expect(controller.snapshot()[0]?.metadata?.streaming).toBe(true)

    controller.ingest(event("session.execution.succeeded", { sessionID: "ses_a" }))
    expect(controller.snapshot()[0]?.metadata?.streaming).toBe(false)
  })

  test("closes stalled text when no ended event arrives", () => {
    const controller = new SessionStreamController()
    controller.ingest(event("session.text.started", { assistantMessageID: "m8" }))
    controller.ingest(event("session.text.delta", { assistantMessageID: "m8", delta: "a" }))
    const start = Date.now()
    controller.pump(start + 100)
    expect(controller.snapshot()[0]?.metadata?.streaming).toBe(true)

    // Drain the one-character buffer, then let the block go idle.
    controller.pump(start + 140)
    controller.pump(start + 1_200)
    expect(controller.snapshot()[0]?.metadata?.streaming).toBe(false)

    // A late delta wakes the same block up again.
    controller.ingest(event("session.text.delta", { assistantMessageID: "m8", delta: "b" }))
    expect(controller.snapshot()[0]?.metadata?.streaming).toBe(true)
  })

  test("updates tool state without waiting for text pacing", async () => {
    const controller = new SessionStreamController()
    controller.ingest(event("session.tool.input.started", { assistantMessageID: "m3", name: "bash" }))
    controller.ingest(event("session.tool.called", { assistantMessageID: "m3", input: { command: "ls" } }))
    controller.ingest(event("session.tool.success", { assistantMessageID: "m3" }))
    controller.pump(Date.now())
    const tool = controller.snapshot()[0]?.content?.find((block) => block.type === "tool")
    expect(tool && tool.type === "tool" ? tool.name : "").toBe("bash")
    expect(tool && tool.type === "tool" ? tool.state?.status : "").toBe("completed")
    expect(tool && tool.type === "tool" ? JSON.stringify(tool.state?.input) : "").toContain("ls")
  })
})
