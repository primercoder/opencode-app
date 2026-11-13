import { sessionBusy, toMillis, type ModelInfo, type SessionInfo, type SessionMessage } from "@/opencode/client"

export type RunningActivity =
  | { kind: "tool"; key: string; label: string; sessionId: string }
  | { kind: "shell"; key: string; label: string; sessionId: string }
  | { kind: "subagent"; key: string; label: string; sessionId: string }

export function runningActivities(messages: SessionMessage[], children: SessionInfo[]): RunningActivity[] {
  const activities: RunningActivity[] = []
  for (const message of messages) {
    if (message.type === "shell" && message.status === "running") {
      activities.push({
        kind: "shell",
        key: message.id,
        label: message.command ?? "shell",
        sessionId: message.shellID ?? message.id,
      })
    }
    if (message.type !== "assistant") continue
    for (const block of message.content ?? []) {
      if (block.type !== "tool") continue
      const status = block.state?.status ?? "running"
      if (status !== "running" && status !== "streaming" && status !== "pending") continue
      activities.push({
        kind: "tool",
        key: `${message.id}:${block.id}`,
        label: block.name || "tool",
        sessionId: block.id,
      })
    }
  }
  for (const child of children) {
    if (!sessionBusy(child)) continue
    activities.push({
      kind: "subagent",
      key: child.id,
      label: child.title?.trim() || child.agent || "subagent",
      sessionId: child.id,
    })
  }
  return activities
}

export type ContextUsage = {
  tokens: number
  limit?: number
  percent?: number
}

export function contextUsage(messages: SessionMessage[], model: ModelInfo | undefined): ContextUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.type !== "assistant" || !message.tokens) continue
    const tokens =
      (message.tokens.input ?? 0) +
      (message.tokens.output ?? 0) +
      (message.tokens.reasoning ?? 0) +
      (message.tokens.cache?.read ?? 0) +
      (message.tokens.cache?.write ?? 0)
    if (tokens <= 0) continue
    const limit = model?.limit?.context
    return {
      tokens,
      ...(limit ? { limit, percent: Math.round((tokens / limit) * 100) } : {}),
    }
  }
  return undefined
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function lastMessageAt(messages: SessionMessage[]): number {
  const last = messages[messages.length - 1]
  return toMillis(last?.time?.created)
}
