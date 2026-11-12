export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta"

export type DiffLine = {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export function parsePatch(patch: string): DiffLine[] {
  const raw = patch.split("\n")
  if (raw[raw.length - 1] === "") raw.pop()

  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of raw) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      lines.push({ kind: "hunk", text: line })
      continue
    }

    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("\\ No newline") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ")
    ) {
      lines.push({ kind: "meta", text: line })
      continue
    }

    if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line, newLine })
      newLine += 1
      continue
    }

    if (line.startsWith("-")) {
      lines.push({ kind: "del", text: line, oldLine })
      oldLine += 1
      continue
    }

    if (line.startsWith(" ")) {
      lines.push({ kind: "context", text: line, oldLine, newLine })
      oldLine += 1
      newLine += 1
      continue
    }

    // Empty context lines in some producers have no leading space.
    if (line === "") {
      lines.push({ kind: "context", text: " ", oldLine, newLine })
      oldLine += 1
      newLine += 1
      continue
    }

    lines.push({ kind: "context", text: line, oldLine, newLine })
  }

  return lines
}
