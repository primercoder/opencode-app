import AsyncStorage from "@react-native-async-storage/async-storage"

export type VoiceEnginePreference = "auto" | "local" | "host" | "system"

const KEY = "ocremote.voiceEngine"

export async function loadVoiceEnginePreference(): Promise<VoiceEnginePreference> {
  const value = await AsyncStorage.getItem(KEY)
  return value === "local" || value === "host" || value === "system" ? value : "auto"
}

export async function saveVoiceEnginePreference(value: VoiceEnginePreference): Promise<void> {
  await AsyncStorage.setItem(KEY, value)
}
