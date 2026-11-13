import { useCallback, useRef, useState } from "react"
import { useT } from "@/i18n"
import { ensureWhisperModel, transcribePcm } from "./localWhisper"
import { selectedMobileModel } from "./models"
import { loadVoiceEnginePreference, type VoiceEnginePreference } from "./preferences"
import { useDictation } from "./useDictation"
import { usePcmDictation } from "./usePcmDictation"
import { pcmToWav } from "./wav"

export type VoiceEngine = "local" | "host" | "system"

export type HostTranscriber = (wav: Uint8Array, durationMs: number) => Promise<string>

export function useVoiceInput(
  onFinal: (text: string) => void,
  options: { hostTranscribe?: HostTranscriber; preference?: VoiceEnginePreference } = {},
): {
  listening: boolean
  transcribing: boolean
  engine: VoiceEngine | null
  error: string | null
  start: (language?: string) => Promise<void>
  stop: () => void
  clearError: () => void
} {
  const t = useT()
  const system = useDictation(onFinal)
  const pcm = usePcmDictation(onFinal)
  const [engine, setEngine] = useState<VoiceEngine | null>(null)
  const [configurationError, setConfigurationError] = useState<string | null>(null)
  const hostRef = useRef(options.hostTranscribe)
  hostRef.current = options.hostTranscribe

  const start = useCallback(
    async (language = "zh-CN") => {
      setConfigurationError(null)
      const lang = language.toLowerCase().startsWith("zh") ? "zh" : language
      const preference: VoiceEnginePreference =
        options.preference ?? (await loadVoiceEnginePreference().catch(() => "auto"))
      const model = await selectedMobileModel().catch(() => undefined)
      const host = hostRef.current

      if (preference === "system") {
        setEngine("system")
        await system.start(language)
        return
      }
      if (preference === "local") {
        if (!model?.path) {
          setConfigurationError(t("needPhoneModel"))
          return
        }
        setEngine("local")
        await pcm.start(async (samples) => {
          await ensureWhisperModel(model.path!)
          return transcribePcm(samples, lang)
        })
        return
      }
      if (preference === "host") {
        if (!host) {
          setConfigurationError(t("hostNoModel"))
          return
        }
        setEngine("host")
        await pcm.start(async (samples, durationMs) => host(pcmToWav(samples), durationMs))
        return
      }

      if (model?.path) {
        setEngine("local")
        await pcm.start(async (samples) => {
          await ensureWhisperModel(model.path!)
          return transcribePcm(samples, lang)
        })
        return
      }
      if (host) {
        setEngine("host")
        await pcm.start(async (samples, durationMs) => host(pcmToWav(samples), durationMs))
        return
      }
      setEngine("system")
      await system.start(language)
    },
    [options.preference, pcm.start, system.start, t],
  )

  const stop = useCallback(() => {
    if (engine === "local" || engine === "host") pcm.stop()
    else system.stop()
  }, [engine, pcm.stop, system.stop])

  const clearError = useCallback(() => {
    setConfigurationError(null)
    pcm.clearError()
    system.clearError()
  }, [pcm.clearError, system.clearError])

  return {
    listening: engine === "local" || engine === "host" ? pcm.recording : system.listening,
    transcribing: pcm.transcribing,
    engine,
    error: configurationError ?? pcm.error ?? system.error,
    start,
    stop,
    clearError,
  }
}
