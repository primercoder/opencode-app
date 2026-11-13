import { describe, expect, test } from "bun:test"
import {
  defaultModelFor,
  formatModelSize,
  modelById,
  modelDownloadUrl,
  modelsForRole,
  MODEL_SPECS,
} from "../src/index.ts"

describe("model catalog", () => {
  test("has one default per role and unique ids", () => {
    expect(new Set(MODEL_SPECS.map((model) => model.id)).size).toBe(MODEL_SPECS.length)
    expect(defaultModelFor("mobile").engine).toBe("whisper-ggml")
    expect(defaultModelFor("host").engine).toBe("sherpa-sense-voice")
    expect(modelsForRole("mobile")).toHaveLength(1)
    expect(modelsForRole("host")).toHaveLength(1)
  })

  test("resolves development and release URLs", () => {
    const spec = modelById("mobile-whisper-base-q5")
    expect(spec).toBeDefined()
    expect(modelDownloadUrl(spec!, "http://10.0.2.2:9000/")).toBe(
      "http://10.0.2.2:9000/models/whisper/ggml-base-q5_1.bin",
    )
    expect(modelDownloadUrl(spec!)).toBe(spec!.releaseUrl)
  })

  test("sizes are readable and hashes are sha256", () => {
    expect(formatModelSize(59_707_625)).toBe("57 MB")
    for (const spec of MODEL_SPECS) expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/u)
  })
})
