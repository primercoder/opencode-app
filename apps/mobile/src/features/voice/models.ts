import { modelDownloadUrl, modelsForRole, type ModelSpec } from "@ocremote/models"
import AsyncStorage from "@react-native-async-storage/async-storage"
import * as DocumentPicker from "expo-document-picker"
import * as FileSystem from "expo-file-system/legacy"

const SELECTED_KEY = "ocremote.mobileVoiceModel"
const SERVER_KEY = "ocremote.modelServer"

export type MobileModelStatus = {
  spec: ModelSpec
  installed: boolean
  path?: string
  selected: boolean
}

export type DownloadProgress = {
  receivedBytes: number
  totalBytes: number
}

export async function mobileModelBaseUrl(): Promise<string | undefined> {
  const override = await AsyncStorage.getItem(SERVER_KEY)
  if (override) return override
  const configured = process.env.EXPO_PUBLIC_MODEL_BASE_URL
  if (configured) return configured
  return __DEV__ ? "http://10.0.2.2:9000" : undefined
}

export async function loadModelServer(): Promise<string> {
  return (await AsyncStorage.getItem(SERVER_KEY)) ?? ""
}

export async function saveModelServer(url: string): Promise<void> {
  const trimmed = url.trim()
  if (trimmed) await AsyncStorage.setItem(SERVER_KEY, trimmed)
  else await AsyncStorage.removeItem(SERVER_KEY)
}

export async function listMobileModels(): Promise<MobileModelStatus[]> {
  const selected = await AsyncStorage.getItem(SELECTED_KEY)
  return Promise.all(
    modelsForRole("mobile").map(async (spec) => {
      const path = modelPath(spec)
      const info = await FileSystem.getInfoAsync(path).catch(() => undefined)
      const installed = Boolean(info?.exists && "size" in info && info.size > 0)
      return { spec, installed, ...(installed ? { path } : {}), selected: selected === spec.id }
    }),
  )
}

export async function downloadMobileModel(spec: ModelSpec, onProgress?: (progress: DownloadProgress) => void): Promise<string> {
  const dir = modelDir(spec)
  const destination = modelPath(spec)
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true })
  await FileSystem.deleteAsync(destination, { idempotent: true })

  const url = modelDownloadUrl(spec, await mobileModelBaseUrl())
  const download = FileSystem.createDownloadResumable(url, destination, {}, (data) => {
    onProgress?.({ receivedBytes: data.totalBytesWritten, totalBytes: data.totalBytesExpectedToWrite || spec.sizeBytes })
  })
  try {
    const result = await download.downloadAsync()
    if (!result?.uri) throw new Error("模型下载失败")
    const info = await FileSystem.getInfoAsync(destination)
    if (!info.exists || !("size" in info) || info.size <= 0) throw new Error("下载的模型文件为空")
    await selectMobileModel(spec.id)
    return destination
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined)
    throw error
  }
}

export async function importMobileModel(spec: ModelSpec): Promise<string | undefined> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ["application/octet-stream", "*/*"],
    copyToCacheDirectory: true,
    multiple: false,
  })
  if (picked.canceled || !picked.assets[0]) return undefined
  const asset = picked.assets[0]
  await FileSystem.makeDirectoryAsync(modelDir(spec), { intermediates: true })
  const destination = modelPath(spec)
  await FileSystem.deleteAsync(destination, { idempotent: true })
  await FileSystem.copyAsync({ from: asset.uri, to: destination })
  const info = await FileSystem.getInfoAsync(destination)
  if (!info.exists || !("size" in info) || info.size <= 0) throw new Error("导入的模型文件为空")
  await selectMobileModel(spec.id)
  return destination
}

export async function removeMobileModel(spec: ModelSpec): Promise<void> {
  await FileSystem.deleteAsync(modelDir(spec), { idempotent: true })
  const selected = await AsyncStorage.getItem(SELECTED_KEY)
  if (selected === spec.id) await AsyncStorage.removeItem(SELECTED_KEY)
}

export async function selectMobileModel(modelId: string): Promise<void> {
  await AsyncStorage.setItem(SELECTED_KEY, modelId)
}

export async function selectedMobileModel(): Promise<MobileModelStatus | undefined> {
  const selected = await AsyncStorage.getItem(SELECTED_KEY)
  const models = await listMobileModels()
  return models.find((model) => model.spec.id === selected && model.installed) ?? models.find((model) => model.installed)
}

function modelDir(spec: ModelSpec): string {
  return `${FileSystem.documentDirectory}models/${spec.id}/`
}

function modelPath(spec: ModelSpec): string {
  return `${modelDir(spec)}${spec.file ?? "model.bin"}`
}
