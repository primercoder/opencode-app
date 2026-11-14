import type { OpencodeEvent } from "@/transport/hostEvents"
import type { AssistantContent, SessionMessage } from "@/opencode/client"

type ToolBlock = Extract<AssistantContent, { type: "tool" }>
type QueueSegment = {
  kind: "text" | "reasoning"
  shown: string
  pending: string
  closed: boolean
}
type ToolSegment = { kind: "tool"; block: ToolBlock }
type Segment = QueueSegment | ToolSegment

type Entry = {
  id: string
  created: number
  segments: Segment[]
  textIndex?: number
  reasoningIndex?: number
  toolIndex?: number
  holdUntil: number
  finishedAt?: number
  lastText?: string
  lastReasoning?: string
}

const FRAME_MS = 33

/**
 * Receives OpenCode stream events independently from rendering. Text and
 * reasoning are buffered and exposed gradually by `pump`; tool calls are
 * discrete state transitions and appear as soon as they happen.
 */
export class SessionStreamController {
  private entries = new Map<string, Entry>()
  private order: string[] = []
  private lastPump = 0
  private dirty = false
  private toolSeq = 0
  private sessionId: string | undefined

  setSession(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.entries.clear()
    this.order = []
    this.lastPump = 0
    this.dirty = false
  }

  reset(): void {
    this.entries.clear()
    this.order = []
    this.lastPump = 0
    this.dirty = false
  }

  ingest(event: OpencodeEvent): void {
    const type = event.type ?? ""
    if (!type.startsWith("session.") && !type.startsWith("message.")) return
    const data = record(event.data)
    const eventSession = stringValue(data.sessionID)
    if (this.sessionId && eventSession && eventSession !== this.sessionId) return

    if (
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.cancelled" ||
      type === "session.execution.ended"
    ) {
      const now = Date.now()
      for (const entry of this.entries.values()) entry.finishedAt ??= now
      this.dirty = true
      return
    }

    const id = stringValue(data.assistantMessageID)
    if (!id) return
    const entry = this.ensure(id, event.created)
    this.dirty = true

    switch (type) {
      case "session.step.started":
        entry.created = numberValue(event.created) ?? entry.created
        break
      case "session.reasoning.started":
        entry.reasoningIndex = this.addQueue(entry, "reasoning")
        break
      case "session.reasoning.delta": {
        const index = entry.reasoningIndex ?? this.addQueue(entry, "reasoning")
        entry.reasoningIndex = index
        this.append(entry, index, stringValue(data.delta) ?? "", false)
        break
      }
      case "session.reasoning.ended": {
        const index = entry.reasoningIndex ?? this.addQueue(entry, "reasoning")
        entry.reasoningIndex = index
        entry.lastReasoning = stringValue(data.text) ?? entry.lastReasoning
        this.append(entry, index, "", true)
        break
      }
      case "session.text.started":
        entry.textIndex = this.addQueue(entry, "text")
        break
      case "session.text.delta": {
        const index = entry.textIndex ?? this.addQueue(entry, "text")
        entry.textIndex = index
        this.append(entry, index, stringValue(data.delta) ?? "", false)
        break
      }
      case "session.text.ended": {
        const index = entry.textIndex ?? this.addQueue(entry, "text")
        entry.textIndex = index
        entry.lastText = stringValue(data.text) ?? entry.lastText
        this.append(entry, index, "", true)
        break
      }
      case "session.tool.input.started": {
        this.toolSeq += 1
        const block: ToolBlock = {
          type: "tool",
          id: `live-tool-${this.toolSeq}`,
          name: stringValue(data.name) || "tool",
          state: { status: "running" },
        }
        entry.segments.push({ kind: "tool", block })
        entry.toolIndex = entry.segments.length - 1
        break
      }
      case "session.tool.called": {
        this.updateTool(entry, { input: data.input, status: "running" })
        break
      }
      case "session.tool.progress":
        this.updateTool(entry, { status: "running" })
        break
      case "session.tool.success":
        this.updateTool(entry, { status: "completed" })
        break
      case "session.tool.error":
      case "session.tool.failed":
        this.updateTool(entry, { status: "error" })
        break
      case "session.step.ended":
        break
      default:
        return
    }
  }

  /** Drain buffers and report whether the visible snapshot changed. */
  pump(now = Date.now()): boolean {
    if (this.lastPump === 0) this.lastPump = now
    const dt = Math.min(100, Math.max(0, now - this.lastPump))
    this.lastPump = now
    let changed = this.dirty
    this.dirty = false

    for (const [id, entry] of this.entries) {
      if (now < entry.holdUntil) continue
      for (const segment of entry.segments) {
        if (segment.kind === "tool" || segment.pending.length === 0) continue
        if (!segment.shown) {
          segment.shown = ""
        }
        const count = Math.max(1, Math.floor(rateFor(segment) * (dt / 1000)))
        if (count > 0) {
          const take = Math.min(count, segment.pending.length)
          segment.shown += segment.pending.slice(0, take)
          segment.pending = segment.pending.slice(take)
          changed = true
        }
      }
      if (entry.finishedAt && !hasPending(entry) && now - entry.finishedAt > 700) {
        this.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.order = this.order.filter((id) => this.entries.has(id))
    return changed
  }

  snapshot(): SessionMessage[] {
    const result: SessionMessage[] = []
    for (const id of this.order) {
      const entry = this.entries.get(id)
      if (!entry) continue
      const content = this.content(entry)
      result.push({
        id,
        type: "assistant",
        time: { created: entry.created },
        content,
        metadata: { live: true, ...(entry.finishedAt ? { finishing: true } : {}) },
      })
    }
    return result
  }

  private ensure(id: string, created: unknown): Entry {
    const existing = this.entries.get(id)
    if (existing) return existing
    const entry: Entry = {
      id,
      created: numberValue(created) ?? Date.now(),
      segments: [],
      holdUntil: 0,
    }
    this.entries.set(id, entry)
    this.order.push(id)
    return entry
  }

  private addQueue(entry: Entry, kind: "text" | "reasoning"): number {
    entry.segments.push({ kind, shown: "", pending: "", closed: false })
    return entry.segments.length - 1
  }

  private append(entry: Entry, index: number, text: string, closed: boolean): void {
    const segment = entry.segments[index]
    if (!segment || segment.kind === "tool") return
    if (!segment.shown && !segment.pending && text && !entry.holdUntil) {
      // Small smoothing buffer before the first visible character.
      entry.holdUntil = Date.now() + 70
    }
    segment.pending += text
    if (closed) {
      segment.closed = true
      const final = segment.kind === "text" ? entry.lastText : entry.lastReasoning
      if (final !== undefined) {
        if (final.startsWith(segment.shown)) segment.pending = final.slice(segment.shown.length)
        else if (final.length >= segment.shown.length + segment.pending.length) {
          segment.pending = final.slice(segment.shown.length)
        }
      }
    }
  }

  private updateTool(entry: Entry, patch: { input?: unknown; status?: string }): void {
    let index = entry.toolIndex
    if (index === undefined) {
      for (let cursor = entry.segments.length - 1; cursor >= 0; cursor -= 1) {
        if (entry.segments[cursor]?.kind === "tool") {
          index = cursor
          break
        }
      }
    }
    if (index === undefined) return
    const segment = entry.segments[index]
    if (!segment || segment.kind !== "tool") return
    segment.block = {
      ...segment.block,
      state: {
        ...segment.block.state,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.input !== undefined ? { input: patch.input } : {}),
      },
    }
  }

  private content(entry: Entry): AssistantContent[] {
    const content: AssistantContent[] = []
    for (const segment of entry.segments) {
      if (segment.kind === "tool") content.push(segment.block)
      else if (segment.shown.length > 0 || segment.pending.length > 0 || !segment.closed) {
        content.push({ type: segment.kind, text: segment.shown })
      }
    }
    if (content.length === 0) content.push({ type: "reasoning", text: "" })
    return content
  }
}

function hasPending(entry: Entry): boolean {
  return entry.segments.some((segment) => segment.kind !== "tool" && segment.pending.length > 0)
}

function rateFor(segment: QueueSegment): number {
  const pending = segment.pending.length
  if (segment.kind === "reasoning") {
    if (pending > 4000) return 300
    if (pending > 800) return 120
    return 32
  }
  if (pending > 4000) return 500
  if (pending > 800) return 180
  return 55
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export const STREAM_FRAME_MS = FRAME_MS
