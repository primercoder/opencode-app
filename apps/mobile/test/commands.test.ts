import { describe, expect, test } from "bun:test"
import {
  CORE_COMMANDS,
  findCoreCommand,
  isUnavailableCommand,
  UNAVAILABLE_COMMANDS,
} from "../src/features/session/commands.ts"

describe("session command catalog", () => {
  test("maps TUI names and aliases to phone actions", () => {
    expect(findCoreCommand("models")?.action).toBe("models")
    expect(findCoreCommand("model")?.action).toBe("models")
    expect(findCoreCommand("agents")?.action).toBe("agents")
    expect(findCoreCommand("agent")?.action).toBe("agents")
    expect(findCoreCommand("mcps")?.action).toBe("mcps")
    expect(findCoreCommand("mcp")?.action).toBe("mcps")
    expect(findCoreCommand("variants")?.action).toBe("variants")
    expect(findCoreCommand("thinking")?.action).toBe("variants")
    expect(findCoreCommand("effort")?.action).toBe("variants")
    expect(findCoreCommand("resume")?.action).toBe("sessions")
    expect(findCoreCommand("continue")?.action).toBe("sessions")
  })

  test("shows terminal-only commands as unavailable, not server commands", () => {
    expect(isUnavailableCommand("rename")).toBe(true)
    expect(isUnavailableCommand("worktrees")).toBe(true)
    expect(isUnavailableCommand("models")).toBe(false)
    expect(isUnavailableCommand("init")).toBe(false)
    expect(new Set(CORE_COMMANDS.map((command) => command.name)).has("rename")).toBe(false)
    expect(UNAVAILABLE_COMMANDS.length).toBeGreaterThan(20)
  })
})
