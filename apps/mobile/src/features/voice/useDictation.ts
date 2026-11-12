import { useCallback, useState } from "react"
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionErrorCode,
} from "expo-speech-recognition"

export function useDictation(onFinal: (text: string) => void): {
  listening: boolean
  error: string | null
  start: (language?: string) => Promise<void>
  stop: () => void
  clearError: () => void
} {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useSpeechRecognitionEvent("start", () => setListening(true))
  useSpeechRecognitionEvent("end", () => setListening(false))
  useSpeechRecognitionEvent("result", (event) => {
    if (!event.isFinal) return
    const text = event.results[0]?.transcript?.trim()
    if (text) onFinal(text)
  })
  useSpeechRecognitionEvent("error", (event) => {
    setListening(false)
    setError(errorMessage(event.error))
  })

  const start = useCallback(async (language = "zh-CN") => {
    setError(null)
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (!permission.granted) {
        setError("需要麦克风权限才能听写")
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
      setError(cause instanceof Error ? cause.message : "无法启动语音识别")
    }
  }, [])

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop()
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { listening, error, start, stop, clearError }
}

function errorMessage(code: ExpoSpeechRecognitionErrorCode): string {
  switch (code) {
    case "not-allowed":
      return "麦克风或语音识别权限被拒绝"
    case "no-speech":
    case "speech-timeout":
      return "没有听清，请重试"
    case "network":
      return "系统语音识别需要网络，或改用主机识别"
    case "language-not-supported":
      return "系统没有安装中文语音包"
    case "busy":
      return "语音识别正忙，请稍后再试"
    case "service-not-allowed":
      return "系统语音识别服务不可用"
    default:
      return "语音识别失败，请重试"
  }
}
