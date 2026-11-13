import { translate } from "@/i18n"
import { usePreferences, type Language } from "@/stores/preferences"

export function relativeTime(timestamp: number, language: Language, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return translate(language, "justNow")
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return translate(language, "minutesAgo", { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return translate(language, "hoursAgo", { n: hours })
  const days = Math.round(hours / 24)
  if (days < 30) return translate(language, "daysAgo", { n: days })
  return new Date(timestamp).toLocaleDateString()
}

export function useRelativeTime(): (timestamp: number) => string {
  const language = usePreferences((state) => state.language)
  return (timestamp) => relativeTime(timestamp, language)
}
