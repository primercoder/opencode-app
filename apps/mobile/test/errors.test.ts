import { describe, expect, test } from "bun:test"
import { describeError, isHostOffline, isOpencodeOffline } from "../src/features/session/errors.ts"
import { HostError } from "../src/transport/hostRuntime.ts"

const t = (key: "error" | "opencodeOffline" | "hostOfflineBody"): string => {
  switch (key) {
    case "opencodeOffline":
      return "opencode is not running"
    case "hostOfflineBody":
      return "host offline"
    default:
      return "error"
  }
}

describe("request error classification", () => {
  test("host-offline errors are distinguished from opencode-offline errors", () => {
    const offline = new HostError("protocol", "opencode is not running on the host", {
      code: "OPENCODE_OFFLINE",
    })
    expect(isOpencodeOffline(offline)).toBe(true)
    expect(isHostOffline(offline)).toBe(false)
    expect(describeError(offline, t)).toBe("opencode is not running")

    const host = new HostError("network", "connection closed")
    expect(isOpencodeOffline(host)).toBe(false)
    expect(isHostOffline(host)).toBe(true)
    expect(describeError(host, t)).toBe("host offline")
  })

  test("a message-only opencode failure is still recognised", () => {
    const error = new Error("request failed: OPENCODE_OFFLINE")
    expect(isOpencodeOffline(error)).toBe(true)
    expect(describeError(error, t)).toBe("opencode is not running")
  })

  test("unknown failures keep their own message", () => {
    const error = new Error("opencode GET /api/x returned HTTP 500")
    expect(isOpencodeOffline(error)).toBe(false)
    expect(describeError(error, t)).toBe("opencode GET /api/x returned HTTP 500")
  })
})
