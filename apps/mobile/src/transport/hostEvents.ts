import type { ConnectionState } from "./hostRuntime"
import { SseParser } from "./sse"

export type OpencodeEvent = {
  id?: string
  type?: string
  created?: number | string
  data?: unknown
  [key: string]: unknown
}

export type HostEventSource = {
  readonly state: ConnectionState
  stream(input: {
    method: string
    path: string
    headers?: Record<string, string>
    signal?: AbortSignal
    timeoutMs?: number
    onChunk: (text: string) => void
  }): Promise<void>
}

/**
 * Keeps one SSE request open per host and fans parsed opencode events out to
 * screens. The loop stops when the runtime is closed and resumes after a
 * reconnect.
 */
export class HostEventStream {
  private running = false
  private abort: AbortController | undefined
  private readonly listeners = new Set<(event: OpencodeEvent) => void>()
  private errorListeners = new Set<(error: Error) => void>()

  constructor(private readonly source: HostEventSource) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.abort?.abort()
    this.abort = undefined
  }

  subscribe(listener: (event: OpencodeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  private async loop(): Promise<void> {
    let failures = 0
    while (this.running) {
      if (this.source.state !== "ready") {
        await delay(1_000)
        continue
      }

      const controller = new AbortController()
      this.abort = controller
      const parser = new SseParser()
      let streamed = false
      try {
        await this.source.stream({
          method: "GET",
          path: "/api/event",
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
          timeoutMs: 0,
          onChunk: (text) => {
            streamed = true
            failures = 0
            for (const raw of parser.push(text)) this.dispatch(raw.data)
          },
        })
        for (const raw of parser.flush()) this.dispatch(raw.data)
      } catch (error) {
        if (!this.running) return
        if (controller.signal.aborted) return
        const failure = error instanceof Error ? error : new Error("event stream failed")
        for (const listener of this.errorListeners) listener(failure)
      } finally {
        if (this.abort === controller) this.abort = undefined
      }

      if (!this.running) return
      // Back off when the stream keeps failing without delivering data, so an
      // unreachable host does not cause a reconnect every second.
      failures = streamed ? 0 : failures + 1
      const wait = failures <= 1 ? 1_000 : Math.min(15_000, 1_000 * 2 ** Math.min(failures - 1, 4))
      await delay(wait)
    }
  }

  private dispatch(data: string): void {
    if (!data) return
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const listener of this.listeners) listener(value as OpencodeEvent)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
