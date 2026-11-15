import { describe, expect, test } from "bun:test"
import { appendVoiceText, voiceSegment } from "../src/features/voice/dictationText.ts"

describe("dictation draft text", () => {
  test("ends every voice segment with an English comma", () => {
    expect(voiceSegment("hello world")).toBe("hello world,")
    expect(voiceSegment("你好，")).toBe("你好,")
    expect(voiceSegment("  done.  ")).toBe("done,")
    expect(voiceSegment("   ")).toBe("")
  })

  test("appends instead of replacing manual text", () => {
    expect(appendVoiceText("manual note", "first take")).toBe("manual note first take,")
    expect(appendVoiceText("", "first take")).toBe("first take,")
    expect(appendVoiceText("manual note ", "first take")).toBe("manual note first take,")
  })

  test("keeps multiple recordings in order", () => {
    const first = appendVoiceText("context:", "first voice")
    const second = appendVoiceText(first, "second voice")
    expect(second).toBe("context: first voice, second voice,")
  })
})
