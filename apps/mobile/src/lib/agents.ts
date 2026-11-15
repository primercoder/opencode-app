import type { AgentInfo } from "@/opencode/client"

/** Only user-selectable primary agents. Internal hidden helpers are excluded. */
export function visiblePrimaryAgents(agents: AgentInfo[]): AgentInfo[] {
  const order = new Map([
    ["build", 0],
    ["plan", 1],
  ])
  return agents
    .filter((agent) => agent.mode === "primary" && agent.hidden !== true)
    .sort(
      (left, right) =>
        (order.get(left.id) ?? 99) - (order.get(right.id) ?? 99) ||
        left.name.localeCompare(right.name),
    )
}
