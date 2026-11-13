declare module "@fugood/react-native-audio-pcm-stream" {
  export type LiveAudioStreamOptions = {
    sampleRate: number
    channels: number
    bitsPerSample: number
    audioSource?: number
    wavFile?: string
    bufferSize?: number
  }

  const LiveAudioStream: {
    init(options: LiveAudioStreamOptions): void
    start(): void
    stop(): void
    on(event: "data", listener: (data: string) => void): void
    removeAllListeners?(event?: string): void
  }

  export default LiveAudioStream
}
