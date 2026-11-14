export type ReviewSelection = {
  startLine: number
  endLine: number
  startChar: number
  endChar: number
}

export type ReviewComment = {
  type: "file"
  path: string
  selection: ReviewSelection
  comment: string
  preview: string
  origin: "review"
}

export type ReviewPrompt = {
  text: string
  files: Array<{ uri: string; mime: string; name: string }>
  metadata: { comments: ReviewComment[]; attachments: unknown[] }
}

export function selectionRange(anchor: { start: number }, line: number): { start: number; end: number } {
  return line >= anchor.start ? { start: anchor.start, end: line } : { start: line, end: anchor.start }
}

/** Appends the text typed in the session composer after all review comments. */
export function appendReviewText(prompt: ReviewPrompt, text: string): ReviewPrompt {
  const suffix = text.trim()
  if (!suffix) return prompt
  return { ...prompt, text: `${prompt.text}\n\n${suffix}` }
}

export function buildReviewPrompt(directory: string, comments: ReviewComment[]): ReviewPrompt {
  return {
    text: comments
      .map(
        (comment) =>
          `The user made the following comment regarding lines ${comment.selection.startLine} through ${comment.selection.endLine} of ${comment.path}: ${comment.comment}`,
      )
      .join("\n\n"),
    files: comments.map((comment) => ({
      uri: fileUri(directory, comment.path, comment.selection.startLine, comment.selection.endLine),
      mime: "text/plain",
      name: comment.path,
    })),
    metadata: { comments, attachments: [] },
  }
}

function fileUri(directory: string, path: string, start: number, end: number): string {
  const root = directory.replace(/\/+$/u, "")
  const absolute = `${root}/${path.replace(/^\/+/u, "")}`
  const encoded = absolute
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `file://${encoded}?start=${start}&end=${end}`
}
