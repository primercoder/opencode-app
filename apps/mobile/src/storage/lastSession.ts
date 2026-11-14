import AsyncStorage from "@react-native-async-storage/async-storage"

function key(hostId: string): string {
  return `ocremote.lastSession.${hostId}`
}

export async function loadLastSession(hostId: string): Promise<string | undefined> {
  try {
    const value = await AsyncStorage.getItem(key(hostId))
    return value?.trim() || undefined
  } catch {
    return undefined
  }
}

export async function saveLastSession(hostId: string, sessionId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key(hostId), sessionId)
  } catch {
    // best effort
  }
}

export async function clearLastSession(hostId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key(hostId))
  } catch {
    // best effort
  }
}
