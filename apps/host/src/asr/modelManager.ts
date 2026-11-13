import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, mkdir, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import {
  defaultModelFor,
  modelById,
  modelDownloadUrl,
  modelsForRole,
  type ModelSpec,
} from "@ocremote/models"

export type ModelInstallProgress =
  | { phase: "downloading"; receivedBytes: number; totalBytes: number }
  | { phase: "extracting" }
  | { phase: "verifying" }

export type HostModelStatus = {
  spec: ModelSpec
  installed: boolean
  downloading: boolean
  receivedBytes?: number
  totalBytes?: number
  error?: string
}

export type InstalledHostModel = {
  spec: ModelSpec
  dir: string
}

type DownloadState = {
  receivedBytes: number
  totalBytes: number
  error?: string
}

export function defaultHostModelsDir(): string {
  return process.env.OCREMOTE_MODELS_DIR ?? join(homedir(), ".local", "share", "ocremote", "models")
}

export class HostModelManager {
  readonly modelsDir: string
  readonly baseUrl: string | undefined
  private readonly downloads = new Map<string, DownloadState>()
  private readonly active = new Map<string, Promise<InstalledHostModel>>()

  constructor(options: { modelsDir?: string; baseUrl?: string } = {}) {
    this.modelsDir = resolve(options.modelsDir ?? defaultHostModelsDir())
    this.baseUrl = options.baseUrl ?? process.env.OCREMOTE_MODEL_SERVER
  }

  async list(): Promise<HostModelStatus[]> {
    return Promise.all(
      modelsForRole("host").map(async (spec) => {
        const downloading = this.downloads.get(spec.id)
        return {
          spec,
          installed: await this.isInstalled(spec),
          downloading: Boolean(downloading),
          ...(downloading ? { receivedBytes: downloading.receivedBytes, totalBytes: downloading.totalBytes } : {}),
          ...(downloading?.error ? { error: downloading.error } : {}),
        }
      }),
    )
  }

  async installed(): Promise<InstalledHostModel[]> {
    const result: InstalledHostModel[] = []
    for (const spec of modelsForRole("host")) {
      if (await this.isInstalled(spec)) result.push({ spec, dir: this.modelDir(spec) })
    }
    return result
  }

  async resolve(modelId?: string): Promise<InstalledHostModel | undefined> {
    const spec = modelId ? modelById(modelId) : defaultModelFor("host")
    if (!spec || spec.role !== "host") {
      if (modelId) throw new Error(`unknown host model: ${modelId}`)
      return undefined
    }
    if (!(await this.isInstalled(spec))) return undefined
    return { spec, dir: this.modelDir(spec) }
  }

  async install(modelId: string, onProgress?: (progress: ModelInstallProgress) => void): Promise<InstalledHostModel> {
    const spec = hostSpec(modelId)
    const running = this.active.get(spec.id)
    if (running) return running

    const operation = this.installInternal(spec, onProgress).finally(() => this.active.delete(spec.id))
    this.active.set(spec.id, operation)
    return operation
  }

  async import(modelId: string, source: string, onProgress?: (progress: ModelInstallProgress) => void): Promise<InstalledHostModel> {
    const spec = hostSpec(modelId)
    if (!spec.archive) throw new Error(`model ${modelId} is not an archive model`)
    const sourcePath = resolve(source)
    const info = await stat(sourcePath)
    const target = this.modelDir(spec)

    if (info.isDirectory()) {
      for (const file of spec.archive.requiredFiles) {
        const fileInfo = await stat(join(sourcePath, file)).catch(() => undefined)
        if (!fileInfo?.isFile()) throw new Error(`imported directory is missing ${file}`)
      }
      await rm(target, { recursive: true, force: true })
      await cp(sourcePath, target, { recursive: true })
      onProgress?.({ phase: "verifying" })
      return { spec, dir: target }
    }

    if (!info.isFile()) throw new Error(`import source is not a file or directory: ${source}`)
    const actual = await sha256File(sourcePath)
    if (actual !== spec.sha256) throw new Error(`model checksum mismatch: expected ${spec.sha256}, got ${actual}`)

    await rm(target, { recursive: true, force: true })
    const extractionDir = this.extractionDir(spec)
    await mkdir(extractionDir, { recursive: true })
    onProgress?.({ phase: "extracting" })
    try {
      await extractArchive(sourcePath, extractionDir)
      const extracted = join(extractionDir, spec.archive.extractedDir)
      await verifyRequiredFiles(extracted, spec.archive.requiredFiles)
      await rename(extracted, target)
      return { spec, dir: target }
    } finally {
      await rm(extractionDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async remove(modelId: string): Promise<void> {
    const spec = hostSpec(modelId)
    await rm(this.modelDir(spec), { recursive: true, force: true })
    await rm(this.archivePath(spec), { force: true }).catch(() => undefined)
  }

  async isInstalled(spec: ModelSpec): Promise<boolean> {
    if (spec.role !== "host" || !spec.archive) return false
    try {
      await verifyRequiredFiles(this.modelDir(spec), spec.archive.requiredFiles)
      return true
    } catch {
      return false
    }
  }

  private async installInternal(
    spec: ModelSpec,
    onProgress?: (progress: ModelInstallProgress) => void,
  ): Promise<InstalledHostModel> {
    if (!spec.archive) throw new Error(`model ${spec.id} is not an archive model`)
    if (await this.isInstalled(spec)) return { spec, dir: this.modelDir(spec) }

    const archivePath = this.archivePath(spec)
    await mkdir(join(this.modelsDir, ".downloads"), { recursive: true })

    const state: DownloadState = { receivedBytes: 0, totalBytes: spec.sizeBytes }
    this.downloads.set(spec.id, state)
    try {
      if (!(await fileSize(archivePath))) {
        await this.downloadModel(spec, archivePath, state, onProgress)
      }
      onProgress?.({ phase: "verifying" })
      const actual = await sha256File(archivePath)
      if (actual !== spec.sha256) {
        await rm(archivePath, { force: true })
        throw new Error(`downloaded model checksum mismatch: expected ${spec.sha256}, got ${actual}`)
      }

      onProgress?.({ phase: "extracting" })
      const extractionDir = this.extractionDir(spec)
      await rm(extractionDir, { recursive: true, force: true })
      await mkdir(extractionDir, { recursive: true })
      try {
        await extractArchive(archivePath, extractionDir)
        const extracted = join(extractionDir, spec.archive.extractedDir)
        await verifyRequiredFiles(extracted, spec.archive.requiredFiles)
        const target = this.modelDir(spec)
        await rm(target, { recursive: true, force: true })
        await rename(extracted, target)
        return { spec, dir: target }
      } finally {
        await rm(extractionDir, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.downloads.delete(spec.id)
    }
  }

  private async downloadModel(
    spec: ModelSpec,
    archivePath: string,
    state: DownloadState,
    onProgress?: (progress: ModelInstallProgress) => void,
  ): Promise<void> {
    const url = modelDownloadUrl(spec, this.baseUrl)
    const proxy = isLocalUrl(url) ? undefined : (process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY)
    const response = await fetch(url, proxy ? { proxy } : undefined)
    if (!response.ok || !response.body) throw new Error(`model download failed: HTTP ${response.status}`)

    const total = Number(response.headers.get("content-length")) || spec.sizeBytes
    state.totalBytes = total
    const temp = `${archivePath}.part-${Date.now()}`
    const sink = Bun.file(temp).writer()
    try {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        sink.write(value)
        state.receivedBytes += value.byteLength
        onProgress?.({ phase: "downloading", receivedBytes: state.receivedBytes, totalBytes: total })
      }
      await sink.end()
      await rename(temp, archivePath)
    } catch (error) {
      try {
        await sink.end()
      } catch {
        // ignore sink cleanup failures
      }
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private modelDir(spec: ModelSpec): string {
    return join(this.modelsDir, spec.id)
  }

  private archivePath(spec: ModelSpec): string {
    return join(this.modelsDir, ".downloads", basename(spec.devPath))
  }

  private extractionDir(spec: ModelSpec): string {
    return join(this.modelsDir, ".downloads", `${spec.id}.extracting-${Date.now()}`)
  }
}

function hostSpec(modelId: string): ModelSpec {
  const spec = modelById(modelId)
  if (!spec || spec.role !== "host") throw new Error(`unknown host model: ${modelId}`)
  return spec
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const process = Bun.spawn(["tar", "-xjf", archivePath, "-C", destination], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const code = await process.exited
  if (code !== 0) {
    const error = await new Response(process.stderr).text()
    throw new Error(`model extraction failed (${code}): ${error}`)
  }
}

async function verifyRequiredFiles(dir: string, required: string[]): Promise<void> {
  for (const file of required) {
    const info = await stat(join(dir, file)).catch(() => undefined)
    if (!info?.isFile() || info.size === 0) throw new Error(`model is missing ${file}`)
  }
}

async function fileSize(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() ? info.size : 0
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "10.0.2.2"
  } catch {
    return false
  }
}
