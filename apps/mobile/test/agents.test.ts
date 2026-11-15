import { describe, expect, test } from "bun:test"
import type { AgentInfo } from "../src/opencode/client.ts"
import { visiblePrimaryAgents } from "../src/lib/agents.ts"

const agent = (id: string, mode: AgentInfo["mode"], hidden: boolean): AgentInfo => ({
  id,
  name: id,
  mode,
  hidden,
})

describe("visible agents", () => {
  test("keeps only visible primary agents", () => {
    const result = visiblePrimaryAgents([
      agent("summary", "primary", true),
      agent("explore", "subagent", false),
      agent("plan", "primary", false),
      agent("title", "primary", true),
      agent("custom", "primary", false),
      agent("build", "primary", false),
      agent("general", "subagent", false),
      agent("compaction", "primary", true),
    ])
    expect(result.map((item) => item.id)).toEqual(["build", "plan", "custom"])
  })
})
