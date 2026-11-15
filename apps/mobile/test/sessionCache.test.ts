import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessage } from "../src/opencode/client.ts"
import {
  deleteSessionCache,
  readSessionCache,
  updateSessionOffset,
  writeSessionCache,
} from "../src/features/session/sessionCache.ts"

const session = {
  id: "ses_a",
  title: "A",
  location: { directory: "/tmp" },
} as SessionInfo

const message = (id: string): SessionMessage => ({ id, type: "user", text: id })

describe("session cache", () => {
  test("restores messages and scroll offset per host", () => {
    writeSessionCache("host_a", "ses_a", {
      session,
      messages: [message("m1")],
      inbox: [],
      children: [],
      permissions: [],
      forms: [],
      offset: 0,
    })
    updateSessionOffset("host_a", "ses_a", 240)
    const cached = readSessionCache("host_a", "ses_a")
    expect(cached?.messages.map((item) => item.id)).toEqual(["m1"])
    expect(cached?.offset).toBe(240)
    expect(readSessionCache("host_b", "ses_a")).toBeUndefined()
    deleteSessionCache("host_a", "ses_a")
    expect(readSessionCache("host_a", "ses_a")).toBeUndefined()
  })

  test("evicts the least recently written session", () => {
    for (let index = 0; index < 17; index += 1) {
      writeSessionCache("host_a", `ses_${index}`, {
        session: { ...session, id: `ses_${index}` } as SessionInfo,
        messages: [message(`m${index}`)],
        inbox: [],
        children: [],
        permissions: [],
        forms: [],
        offset: 0,
      })
    }
    expect(readSessionCache("host_a", "ses_0")).toBeUndefined()
    expect(readSessionCache("host_a", "ses_16")?.messages[0]?.id).toBe("m16")
  })
})
