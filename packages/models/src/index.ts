export type ModelRole = "mobile" | "host"
export type ModelEngine = "whisper-ggml" | "sherpa-sense-voice"

export type ModelSpec = {
  id: string
  role: ModelRole
  kind: "stt"
  engine: ModelEngine
  label: string
  description: string
  languages: string[]
  /** Download size in bytes (archive size for sherpa models). */
  sizeBytes: number
  sha256: string
  /** Path used by the development model server, relative to its models root. */
  devPath: string
  /** Upstream URL used by release builds. */
  releaseUrl: string
  default?: boolean
  /** Whisper GGML file name inside the model directory. */
  file?: string
  /** Sherpa archive extraction metadata. */
  archive?: {
    extractedDir: string
    requiredFiles: string[]
  }
}

export const MODEL_SPECS: ModelSpec[] = [
  {
    id: "mobile-whisper-base-q5",
    role: "mobile",
    kind: "stt",
    engine: "whisper-ggml",
    label: "Whisper Base (Q5)",
    description: "60 MB multilingual model for offline dictation on the phone.",
    languages: ["zh", "en", "ja", "ko", "fr", "de", "es", "ru"],
    sizeBytes: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    devPath: "whisper/ggml-base-q5_1.bin",
    releaseUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
    default: true,
    file: "ggml-base-q5_1.bin",
  },
  {
    id: "host-sense-voice-int8",
    role: "host",
    kind: "stt",
    engine: "sherpa-sense-voice",
    label: "SenseVoice Small",
    description: "Fast Chinese, Cantonese, English, Japanese and Korean transcription on the host CPU.",
    languages: ["zh", "yue", "en", "ja", "ko"],
    sizeBytes: 165_783_878,
    sha256: "7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63",
    devPath: "sherpa/sense-voice.tar.bz2",
    releaseUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2",
    default: true,
    archive: {
      extractedDir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
      requiredFiles: ["model.int8.onnx", "tokens.txt"],
    },
  },
]

export function modelsForRole(role: ModelRole): ModelSpec[] {
  return MODEL_SPECS.filter((spec) => spec.role === role)
}

export function defaultModelFor(role: ModelRole): ModelSpec {
  const model = modelsForRole(role).find((spec) => spec.default)
  if (!model) throw new Error(`no default model for role ${role}`)
  return model
}

export function modelById(id: string): ModelSpec | undefined {
  return MODEL_SPECS.find((spec) => spec.id === id)
}

/**
 * Development builds point at a local model server; release builds use the
 * upstream URLs embedded here.
 */
export function modelDownloadUrl(spec: ModelSpec, devBaseUrl?: string): string {
  if (!devBaseUrl) return spec.releaseUrl
  return `${devBaseUrl.replace(/\/+$/u, "")}/models/${spec.devPath}`
}

export function formatModelSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}
