import { useCallback, useEffect, useRef, useState } from "react"
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
  /** Stop capture but keep the recording for confirm/cancel. */
  pause: () => void
  /** Send the recording to the selected recognizer. */
  confirm: () => void
  /** Discard the recording without recognition. */
  cancel: () => void
  clearError: () => void
} {
  const t = useT()
  const onFinalRef = useRef(onFinal)
  useEffect(() => {
    onFinalRef.current = onFinal
  }, [onFinal])

  const deliver = useCallback((text: string) => {
    const clean = text.trim()
    if (clean) onFinalRef.current(clean)
  }, [])

  const pcm = usePcmDictation(deliver)
  const engineRef = useRef<VoiceEngine | null>(null)
  const systemText = useRef<string | null>(null)
  const systemAccepted = useRef(false)
  const [finalizing, setFinalizing] = useState(false)

  // System recognition may finalize immediately after the user stops. Buffer
  // that text until the user confirms, so cancel can discard it.
  const system = useDictation((text) => {
    systemText.current = text
    if (!systemAccepted.current) return
    systemText.current = null
    setFinalizing(false)
    deliver(text)
  })

  const [engine, setEngine] = useState<VoiceEngine | null>(null)
  const [configurationError, setConfigurationError] = useState<string | null>(null)
  const hostRef = useRef(options.hostTranscribe)
  hostRef.current = options.hostTranscribe

  const start = useCallback(
    async (language = "zh-CN") => {
      setConfigurationError(null)
      setFinalizing(false)
      systemText.current = null
      systemAccepted.current = false
      const lang = language.toLowerCase().startsWith("zh") ? "zh" : language
      const preference: VoiceEnginePreference =
        options.preference ?? (await loadVoiceEnginePreference().catch(() => "auto"))
      const model = await selectedMobileModel().catch(() => undefined)
      const host = hostRef.current

      if (preference === "system") {
        engineRef.current = "system"
        setEngine("system")
        await system.start(language)
        return
      }
      if (preference === "local") {
        if (!model?.path) {
          setConfigurationError(t("needPhoneModel"))
          return
        }
        engineRef.current = "local"
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
        engineRef.current = "host"
        setEngine("host")
        await pcm.start(async (samples, durationMs) => host(pcmToWav(samples), durationMs))
        return
      }

      if (model?.path) {
        engineRef.current = "local"
        setEngine("local")
        await pcm.start(async (samples) => {
          await ensureWhisperModel(model.path!)
          return transcribePcm(samples, lang)
        })
        return
      }
      if (host) {
        engineRef.current = "host"
        setEngine("host")
        await pcm.start(async (samples, durationMs) => host(pcmToWav(samples), durationMs))
        return
      }
      engineRef.current = "system"
      setEngine("system")
      await system.start(language)
    },
    [options.preference, pcm.start, system.start, t],
  )

  const pause = useCallback(() => {
    if (engineRef.current === "local" || engineRef.current === "host") pcm.pause()
    else if (engineRef.current === "system") system.stop()
  }, [pcm.pause, system.stop])

  const confirm = useCallback(() => {
    if (engineRef.current === "system") {
      systemAccepted.current = true
      const pending = systemText.current
      if (pending) {
        systemText.current = null
        setFinalizing(false)
        deliver(pending)
      } else {
        setFinalizing(true)
      }
      return
    }
    pcm.confirm()
  }, [deliver, pcm.confirm])

  const cancel = useCallback(() => {
    systemAccepted.current = false
    systemText.current = null
    setFinalizing(false)
    if (engineRef.current === "system") system.cancel()
    else pcm.cancel()
  }, [pcm.cancel, system.cancel])

  useEffect(() => {
    if (system.error) setFinalizing(false)
  }, [system.error])

  useEffect(() => {
    if (!finalizing) return
    const timer = setTimeout(() => setFinalizing(false), 15_000)
    return () => clearTimeout(timer)
  }, [finalizing])

  const clearError = useCallback(() => {
    setConfigurationError(null)
    setFinalizing(false)
    pcm.clearError()
    system.clearError()
  }, [pcm.clearError, system.clearError])

  return {
    listening: engine === "local" || engine === "host" ? pcm.recording : system.listening,
    transcribing: pcm.transcribing || finalizing,
    engine,
    error: configurationError ?? pcm.error ?? system.error,
    start,
    pause,
    confirm,
    cancel,
    clearError,
  }
}
