export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: Array<{ level: number; text: string }> }
  | { type: "quote"; text: string }
  | { type: "rule" }
  | { type: "table"; rows: string[][] }

export function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n/gu, "\n").split("\n")
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""

    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        body.push(lines[index] ?? "")
        index += 1
      }
      index += 1
      blocks.push({ type: "code", lang, text: body.join("\n") })
      continue
    }

    if (!line.trim()) {
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" })
      index += 1
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/u.test(line)) {
      blocks.push({ type: "rule" })
      index += 1
      continue
    }

    if (/^>\s?/u.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^>\s?/u.test(lines[index] ?? "")) {
        body.push((lines[index] ?? "").replace(/^>\s?/u, ""))
        index += 1
      }
      blocks.push({ type: "quote", text: body.join(" ") })
      continue
    }

    if (/^\s*([-*+]|\d+\.)\s+/u.test(line)) {
      const ordered = /^\s*\d+\./u.test(line)
      const items: Array<{ level: number; text: string }> = []
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/u.test(lines[index] ?? "")) {
        const current = lines[index] ?? ""
        const indent = current.match(/^\s*/u)?.[0].length ?? 0
        const item = current.replace(/^\s*([-*+]|\d+\.)\s+/u, "")
        items.push({ level: Math.min(3, Math.floor(indent / 2)), text: item })
        index += 1
      }
      blocks.push({ type: "list", ordered, items })
      continue
    }

    if (/^\s*\|.*\|\s*$/u.test(line)) {
      const rows: string[][] = []
      while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index] ?? "")) {
        const current = (lines[index] ?? "").trim()
        if (!/^\|[\s:|-]+\|$/u.test(current)) {
          rows.push(
            current
              .slice(1, -1)
              .split("|")
              .map((cell) => cell.trim()),
          )
        }
        index += 1
      }
      blocks.push({ type: "table", rows })
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^\s*(#{1,6}\s|>|```|([-*+]|\d+\.)\s+|\|)/u.test(lines[index] ?? "")
    ) {
      paragraph.push((lines[index] ?? "").trim())
      index += 1
    }
    if (paragraph.length === 0) {
      paragraph.push(line.trim())
      index += 1
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") })
  }

  return blocks
}
