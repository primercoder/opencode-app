import { initWhisper, type WhisperContext } from "whisper.rn"

let context: WhisperContext | undefined
let loadedPath: string | undefined

export async function ensureWhisperModel(modelPath: string): Promise<WhisperContext> {
  if (context && loadedPath === modelPath) return context
  await releaseWhisperModel()
  context = await initWhisper({ filePath: modelPath, useGpu: false })
  loadedPath = modelPath
  return context
}

export async function transcribePcm(samples: Int16Array, language = "zh"): Promise<string> {
  if (!context) throw new Error("语音模型尚未加载")
  const buffer = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer
  const { promise } = context.transcribeData(buffer, {
    language,
    maxThreads: 4,
    translate: false,
    temperature: 0,
  })
  const result = await promise
  return result.result.trim()
}

export async function transcribeFile(filePath: string, language = "zh"): Promise<string> {
  if (!context) throw new Error("语音模型尚未加载")
  const { promise } = context.transcribe(filePath, { language, maxThreads: 4 })
  const result = await promise
  return result.result.trim()
}

export async function releaseWhisperModel(): Promise<void> {
  const current = context
  context = undefined
  loadedPath = undefined
  await current?.release().catch(() => undefined)
}

export function loadedWhisperPath(): string | undefined {
  return loadedPath
}
