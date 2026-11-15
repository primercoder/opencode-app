import { useCallback, useRef, useState } from "react"
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionErrorCode,
} from "expo-speech-recognition"
import { useT } from "@/i18n"

export function useDictation(onFinal: (text: string) => void): {
  listening: boolean
  error: string | null
  start: (language?: string) => Promise<void>
  stop: () => void
  cancel: () => void
  clearError: () => void
} {
  const t = useT()
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const discard = useRef(false)

  useSpeechRecognitionEvent("start", () => setListening(true))
  useSpeechRecognitionEvent("end", () => setListening(false))
  useSpeechRecognitionEvent("result", (event) => {
    if (discard.current || !event.isFinal) return
    const text = event.results[0]?.transcript?.trim()
    if (text) onFinal(text)
  })
  useSpeechRecognitionEvent("error", (event) => {
    setListening(false)
    setError(errorMessage(event.error, t))
  })

  const start = useCallback(async (language = "zh-CN") => {
    setError(null)
    discard.current = false
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (!permission.granted) {
        setError(t("micPermission"))
        return
      }
      ExpoSpeechRecognitionModule.start({
        lang: language,
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
        maxAlternatives: 1,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("recognitionFailed"))
    }
  }, [t])

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop()
  }, [])

  const cancel = useCallback(() => {
    discard.current = true
    setListening(false)
    try {
      ExpoSpeechRecognitionModule.abort()
    } catch {
      ExpoSpeechRecognitionModule.stop()
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { listening, error, start, stop, cancel, clearError }
}

function errorMessage(code: ExpoSpeechRecognitionErrorCode, t: ReturnType<typeof useT>): string {
  switch (code) {
    case "not-allowed":
      return t("micDenied")
    case "no-speech":
    case "speech-timeout":
      return t("noSpeechHeard")
    case "network":
      return t("systemNeedsNetwork")
    case "language-not-supported":
      return t("systemNoLanguage")
    case "busy":
      return t("systemBusy")
    case "service-not-allowed":
      return t("systemUnavailable")
    default:
      return t("recognitionFailed")
  }
}
