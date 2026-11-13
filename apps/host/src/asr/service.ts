import * as sherpa from "sherpa-onnx-node"
import type { ModelSpec } from "@ocremote/models"
import { HostModelManager } from "./modelManager.ts"
import { parseWav } from "./wav.ts"

export type AsrErrorCode = "ASR_UNAVAILABLE" | "ASR_BUSY" | "ASR_BAD_AUDIO" | "ASR_TOO_LARGE" | "ASR_FAILED"

export class AsrError extends Error {
  constructor(
    readonly code: AsrErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AsrError"
  }
}

export interface AsrService {
  capabilities(): Promise<Record<string, unknown>>
  transcribe(wav: Uint8Array, options?: { modelId?: string; language?: string }): Promise<AsrResult>
  close(): void
}

export type AsrResult = {
  text: string
  engine: string
  model: string
  language?: string
  durationMs: number
  segments: Array<{ startMs: number; endMs: number; text: string }>
}

type LoadedRecognizer = {
  spec: ModelSpec
  recognizer: sherpa.OfflineRecognizer
}

export class HostAsr implements AsrService {
  private loaded: LoadedRecognizer | undefined
  private busy = false

  constructor(
    private readonly models: HostModelManager,
    private readonly defaultModelId?: string,
  ) {}

  async capabilities(): Promise<Record<string, unknown>> {
    const installed = await this.models.installed()
    const active = await this.models.resolve().catch(() => undefined)
    return {
      available: Boolean(active),
      engine: "sherpa-onnx",
      maxAudioSeconds: 60,
      streaming: false,
      models: installed.map(({ spec }) => ({
        id: spec.id,
        name: spec.label,
        languages: spec.languages,
        sizeMB: Math.round(spec.sizeBytes / (1024 * 1024)),
        loaded: this.loaded?.spec.id === spec.id,
      })),
    }
  }

  async transcribe(wav: Uint8Array, options: { modelId?: string; language?: string } = {}): Promise<AsrResult> {
    if (this.busy) throw new AsrError("ASR_BUSY", "another transcription is in progress")
    this.busy = true
    try {
      const resolved = await this.models.resolve(options.modelId ?? this.defaultModelId)
      if (!resolved) throw new AsrError("ASR_UNAVAILABLE", "no speech model is installed on the host")
      if (wav.byteLength > 5 * 1024 * 1024) throw new AsrError("ASR_TOO_LARGE", "audio exceeds 5 MiB")
      const audio = parseWav(wav)
      if (audio.durationMs > 60_000) throw new AsrError("ASR_TOO_LARGE", "audio exceeds 60 seconds")
      if (audio.sampleRate !== 16_000) {
        throw new AsrError("ASR_BAD_AUDIO", `expected 16 kHz audio, received ${audio.sampleRate} Hz`)
      }

      const recognizer = await this.ensureRecognizer(resolved.spec, resolved.dir)
      const stream = recognizer.createStream()
      try {
        stream.acceptWaveform({ samples: audio.samples, sampleRate: audio.sampleRate })
        recognizer.decode(stream)
        const result = recognizer.getResult(stream)
        const text = (result?.text ?? "").trim()
        return {
          text,
          engine: "sherpa-onnx",
          model: resolved.spec.id,
          ...(result?.lang ? { language: cleanLang(result.lang) } : {}),
          durationMs: audio.durationMs,
          segments: text ? [{ startMs: 0, endMs: audio.durationMs, text }] : [],
        }
      } finally {
        stream.free?.()
      }
    } catch (error) {
      if (error instanceof AsrError) throw error
      throw new AsrError("ASR_FAILED", error instanceof Error ? error.message : "speech recognition failed")
    } finally {
      this.busy = false
    }
  }

  close(): void {
    try {
      this.loaded?.recognizer.free?.()
    } catch {
      // ignore native cleanup failures
    }
    this.loaded = undefined
  }

  private async ensureRecognizer(spec: ModelSpec, dir: string): Promise<sherpa.OfflineRecognizer> {
    if (this.loaded?.spec.id === spec.id) return this.loaded.recognizer
    this.close()
    if (spec.engine !== "sherpa-sense-voice" || !spec.archive) {
      throw new AsrError("ASR_UNAVAILABLE", `unsupported host model engine: ${spec.engine}`)
    }

    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: `${dir}/model.int8.onnx`,
          language: "",
          useInverseTextNormalization: 1,
        },
        tokens: `${dir}/tokens.txt`,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
    })
    this.loaded = { spec, recognizer }
    return recognizer
  }
}

function cleanLang(language: string): string {
  return language.replace(/^<\|/u, "").replace(/\|>$/u, "")
}
