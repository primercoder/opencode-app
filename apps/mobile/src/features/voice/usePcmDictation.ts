import { useCallback, useEffect, useRef, useState } from "react"
import { PermissionsAndroid, Platform } from "react-native"
import LiveAudioStream from "@fugood/react-native-audio-pcm-stream"
import { decodeBase64 } from "@/lib/base64"

let activeHandler: ((data: string) => void) | null = null
let listenerInstalled = false

function installListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  LiveAudioStream.on("data", (data) => activeHandler?.(data))
}

export type PcmTranscriber = (samples: Int16Array, durationMs: number) => Promise<string>

export function usePcmDictation(onFinal: (text: string) => void): {
  recording: boolean
  transcribing: boolean
  error: string | null
  start: (transcribe: PcmTranscriber) => Promise<void>
  stop: () => void
  cancel: () => void
  clearError: () => void
} {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chunks = useRef<Uint8Array[]>([])
  const bytes = useRef(0)
  const activeTranscriber = useRef<PcmTranscriber | null>(null)
  const stopRequested = useRef(false)
  const onFinalRef = useRef(onFinal)

  useEffect(() => {
    onFinalRef.current = onFinal
  }, [onFinal])

  useEffect(() => {
    return () => {
      activeHandler = null
      void LiveAudioStream.stop().catch(() => undefined)
    }
  }, [])

  const start = useCallback(async (transcribe: PcmTranscriber) => {
    setError(null)
    setTranscribing(false)
    stopRequested.current = false
    activeTranscriber.current = transcribe
    try {
      if (Platform.OS === "android") {
        const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
        if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
          setError("需要麦克风权限才能听写")
          return
        }
      }
      chunks.current = []
      bytes.current = 0
      LiveAudioStream.init({
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6,
        bufferSize: 4096,
        wavFile: "",
      })
      installListener()
      activeHandler = (data) => {
        if (stopRequested.current) return
        const chunk = decodeBase64(data)
        chunks.current.push(chunk)
        bytes.current += chunk.byteLength
      }
      LiveAudioStream.start()
      setRecording(true)
    } catch (cause) {
      activeHandler = null
      setRecording(false)
      setError(cause instanceof Error ? cause.message : "无法启动麦克风")
    }
  }, [])

  const stop = useCallback(() => {
    if (!recording) return
    stopRequested.current = true
    setRecording(false)
    activeHandler = null
    void finish()
  }, [recording])

  const finish = async () => {
    try {
      await LiveAudioStream.stop()
    } catch {
      // ignore native stop failures
    }
    if (bytes.current < 3_200) {
      setError("没有听清，请重试")
      chunks.current = []
      bytes.current = 0
      return
    }

    const audio = new Uint8Array(bytes.current)
    let offset = 0
    for (const chunk of chunks.current) {
      audio.set(chunk, offset)
      offset += chunk.byteLength
    }
    chunks.current = []
    bytes.current = 0
    const durationMs = Math.round((audio.byteLength / 2 / 16_000) * 1000)
    const samples = new Int16Array(audio.buffer, 0, Math.floor(audio.byteLength / 2))
    let energy = 0
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index] ?? 0
      energy += value * value
    }
    const rms = Math.sqrt(energy / Math.max(1, samples.length)) / 32768
    if (rms < 0.004) {
      setError("没有听清，请重试")
      return
    }

    setTranscribing(true)
    try {
      const text = await activeTranscriber.current?.(samples, durationMs)
      if (text) onFinalRef.current(text)
      else setError("没有听清，请重试")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "语音识别失败")
    } finally {
      setTranscribing(false)
    }
  }

  const cancel = useCallback(() => {
    stopRequested.current = true
    activeHandler = null
    setRecording(false)
    chunks.current = []
    bytes.current = 0
    void LiveAudioStream.stop().catch(() => undefined)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { recording, transcribing, error, start, stop, cancel, clearError }
}
