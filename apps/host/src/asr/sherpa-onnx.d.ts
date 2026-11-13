declare module "sherpa-onnx-node" {
  export type Wave = { samples: Float32Array; sampleRate: number }

  export class OfflineRecognizer {
    constructor(config: unknown)
    createStream(): {
      acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
      free?(): void
    }
    decode(stream: unknown): void
    getResult(stream: unknown): {
      text?: string
      lang?: string
      emotion?: string
      event?: string
      tokens?: string[]
      timestamps?: number[]
      durations?: number[]
    }
    free?(): void
  }

  export function readWave(path: string): Wave
  export const version: string
}
