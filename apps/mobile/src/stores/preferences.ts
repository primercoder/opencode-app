import AsyncStorage from "@react-native-async-storage/async-storage"
import { create } from "zustand"

export type ThemeMode = "system" | "light" | "dark"
export type Language = "zh" | "en"
export type VoiceEnginePreference = "auto" | "local" | "host" | "system"

type PreferencesState = {
  hydrated: boolean
  themeMode: ThemeMode
  language: Language
  notifications: boolean
  voiceEngine: VoiceEnginePreference
  hydrate(): Promise<void>
  setThemeMode(value: ThemeMode): Promise<void>
  setLanguage(value: Language): Promise<void>
  setNotifications(value: boolean): Promise<void>
  setVoiceEngine(value: VoiceEnginePreference): Promise<void>
}

const KEYS = {
  themeMode: "ocremote.pref.theme",
  language: "ocremote.pref.language",
  notifications: "ocremote.pref.notifications",
  voiceEngine: "ocremote.pref.voiceEngine",
} as const

export const usePreferences = create<PreferencesState>((set, get) => ({
  hydrated: false,
  themeMode: "system",
  language: "zh",
  notifications: true,
  voiceEngine: "auto",

  async hydrate() {
    if (get().hydrated) return
    const values = await AsyncStorage.multiGet(Object.values(KEYS)).catch(() => [])
    const read = (key: string) => values.find(([stored]) => stored === key)?.[1] ?? null
    const theme = read(KEYS.themeMode)
    const language = read(KEYS.language)
    const notifications = read(KEYS.notifications)
    const voice = read(KEYS.voiceEngine)
    set({
      hydrated: true,
      themeMode: theme === "light" || theme === "dark" ? theme : "system",
      language: language === "en" ? "en" : "zh",
      notifications: notifications === null ? true : notifications === "1",
      voiceEngine:
        voice === "local" || voice === "host" || voice === "system" ? voice : "auto",
    })
  },

  async setThemeMode(value) {
    set({ themeMode: value })
    await AsyncStorage.setItem(KEYS.themeMode, value)
  },
  async setLanguage(value) {
    set({ language: value })
    await AsyncStorage.setItem(KEYS.language, value)
  },
  async setNotifications(value) {
    set({ notifications: value })
    await AsyncStorage.setItem(KEYS.notifications, value ? "1" : "0")
  },
  async setVoiceEngine(value) {
    set({ voiceEngine: value })
    await AsyncStorage.setItem(KEYS.voiceEngine, value)
  },
}))

const SESSION_VOICE_PREFIX = "ocremote.sessionVoice."

export async function loadSessionVoiceEngine(sessionId: string): Promise<VoiceEnginePreference | undefined> {
  try {
    const value = await AsyncStorage.getItem(`${SESSION_VOICE_PREFIX}${sessionId}`)
    if (value === "local" || value === "host" || value === "system" || value === "auto") return value
  } catch {
    // ignore
  }
  return undefined
}

export async function saveSessionVoiceEngine(sessionId: string, value: VoiceEnginePreference): Promise<void> {
  await AsyncStorage.setItem(`${SESSION_VOICE_PREFIX}${sessionId}`, value)
}
