import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useColorScheme } from "react-native"
import { usePreferences, type ThemeMode } from "@/stores/preferences"

const light = {
  bg: "#FFFFFF",
  surface: "#F6F8FB",
  surface2: "#EDF1F7",
  text: "#0E1520",
  muted: "#5B6573",
  faint: "#8A94A3",
  border: "#E3E8EF",
  accent: "#2F6BFF",
  accentText: "#FFFFFF",
  accentSoft: "#E9F0FF",
  danger: "#D92E3C",
  dangerSoft: "#FDECEE",
  success: "#168A4A",
  warning: "#A2610A",
  codeBg: "#F2F5FA",
  overlap: "rgba(0,0,0,0.28)",
} as const

const dark: Palette = {
  bg: "#0B0F17",
  surface: "#121824",
  surface2: "#1A2231",
  text: "#E9EEF7",
  muted: "#9AA7B8",
  faint: "#6E7C8F",
  border: "#222C3D",
  accent: "#4C85FF",
  accentText: "#FFFFFF",
  accentSoft: "#16233C",
  danger: "#FF6B78",
  dangerSoft: "#301820",
  success: "#47C97E",
  warning: "#F0B35B",
  codeBg: "#0E141F",
  overlap: "rgba(0,0,0,0.55)",
}

export type Palette = {
  [K in keyof typeof light]: string
}

export const colors: Palette = light
export { light as lightPalette, dark as darkPalette }

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  full: 999,
} as const

type ThemeValue = {
  colors: Palette
  scheme: "light" | "dark"
  mode: ThemeMode
}

const ThemeContext = createContext<ThemeValue>({ colors: light, scheme: "light", mode: "system" })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme()
  const mode = usePreferences((state) => state.themeMode)
  const scheme: "light" | "dark" = mode === "system" ? (system === "dark" ? "dark" : "light") : mode
  const value = useMemo<ThemeValue>(
    () => ({ colors: scheme === "dark" ? dark : light, scheme, mode }),
    [scheme, mode],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}

/** Memoizes a StyleSheet factory against the active palette. */
export function useThemedStyles<T>(factory: (colors: Palette) => T): T {
  const { colors: palette } = useTheme()
  return useMemo(() => factory(palette), [factory, palette])
}
