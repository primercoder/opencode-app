export type SseEvent = {
  event?: string
  id?: string
  data: string
}

export class SseParser {
  private buffer = ""
  private event: string | undefined
  private id: string | undefined
  private data: string[] = []

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    let newline = this.buffer.indexOf("\n")
    while (newline !== -1) {
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      this.line(line, events)
      newline = this.buffer.indexOf("\n")
    }
    return events
  }

  flush(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer
      this.buffer = ""
      this.line(line, events)
    }
    this.dispatch(events)
    return events
  }

  private line(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.dispatch(events)
      return
    }
    if (line.startsWith(":")) return
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") this.event = value
    else if (field === "id") this.id = value
    else if (field === "data") this.data.push(value)
  }

  private dispatch(events: SseEvent[]): void {
    if (this.data.length === 0) {
      this.event = undefined
      this.id = undefined
      return
    }
    events.push({
      ...(this.event !== undefined ? { event: this.event } : {}),
      ...(this.id !== undefined ? { id: this.id } : {}),
      data: this.data.join("\n"),
    })
    this.event = undefined
    this.id = undefined
    this.data = []
  }
}
