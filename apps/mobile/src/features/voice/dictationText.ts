/**
 * Normalizes one dictation result and appends it to the current draft.
 *
 * Dictation must never replace text the user typed or a previous recording.
 * Each segment ends in an English comma; the previous draft is kept intact.
 */
export function voiceSegment(text: string): string {
  const clean = text
    .trim()
    .replace(/[，,。.！!？?；;：:]+$/u, "")
    .trim()
  return clean ? `${clean},` : ""
}

export function appendVoiceText(current: string, text: string): string {
  const segment = voiceSegment(text)
  if (!segment) return current
  const base = current.replace(/\s+$/u, "")
  return base ? `${base} ${segment}` : segment
}
