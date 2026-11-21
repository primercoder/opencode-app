import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessage } from "../src/opencode/client.ts"
import { markSessionStopped, runningActivities } from "../src/features/session/activity.ts"

const now = 1_000_000_000_000

const toolMessage = (status: string, created: number): SessionMessage => ({
  id: "msg_1",
  type: "assistant",
  time: { created },
  content: [
    { type: "tool", id: "tool_1", name: "bash", state: { status }, time: { created } },
  ],
})

const shellMessage = (status: string, created: number): SessionMessage => ({
  id: "msg_shell",
  type: "shell",
  status,
  command: "sleep 100",
  time: { created },
})

function child(busy: number, idle: number): SessionInfo {
  return { id: "ses_child", title: "Sub", time: { busy, idle } } as SessionInfo
}

describe("running activities", () => {
  test("reports a fresh running tool while the session is busy", () => {
    const list = runningActivities([toolMessage("running", now - 1_000)], [], { busy: true, now })
    expect(list.map((item) => item.kind)).toEqual(["tool"])
    expect(list[0]?.label).toBe("bash")
  })

  test("drops a stale running tool once the turn is over", () => {
    // The bug: the final tool update was lost, leaving "1 task running" and a
    // dead stop button on an idle session forever.
    expect(runningActivities([toolMessage("running", now - 4 * 60_000)], [], { busy: false, now })).toEqual([])
  })

  test("keeps a tool that just started even if the turn already ended", () => {
    const list = runningActivities([toolMessage("running", now - 100)], [], { busy: false, now })
    expect(list).toHaveLength(1)
  })

  test("drops a live tool with no timestamp when the turn is over", () => {
    const message: SessionMessage = {
      id: "msg_2",
      type: "assistant",
      content: [{ type: "tool", id: "tool_2", name: "read", state: { status: "running" } }],
    }
    expect(runningActivities([message], [], { busy: false, now })).toEqual([])
  })

  test("background shells survive an idle turn while recent", () => {
    const list = runningActivities([shellMessage("running", now - 60_000)], [], { busy: false, now })
    expect(list.map((item) => item.kind)).toEqual(["shell"])
  })

  test("background shells are dropped once stale", () => {
    const list = runningActivities([shellMessage("running", now - 11 * 60_000)], [], { busy: false, now })
    expect(list).toEqual([])
  })

  test("busy subagent sessions are listed", () => {
    const list = runningActivities([], [child(now, now - 1_000)], { busy: true, now })
    expect(list.map((item) => item.kind)).toEqual(["subagent"])
  })

  test("idle subagent sessions are not listed", () => {
    expect(runningActivities([], [child(now - 1_000, now)], { busy: true, now })).toEqual([])
  })
})

describe("markSessionStopped", () => {
  test("clears busy so the stop button disappears immediately", () => {
    const value = markSessionStopped(
      { id: "ses_a", time: { busy: 500, idle: 100 } } as SessionInfo,
      now,
    )
    expect(value.outcome).toBe("cancelled")
    expect(value.time?.idle).toBe(now)
  })
})
