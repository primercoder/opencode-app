import { installRuntimePolyfills } from "@/polyfills"

installRuntimePolyfills()

import * as SplashScreen from "expo-splash-screen"
import { router, Stack, useRootNavigationState } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { Linking, StatusBar, View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { ThemeProvider, useTheme } from "@/theme"
import { usePreferences } from "@/stores/preferences"
import { useHosts } from "@/stores/hosts"

void SplashScreen.preventAutoHideAsync().catch(() => undefined)

export default function RootLayout() {
  const [ready, setReady] = useState(false)
  const hydratePreferences = usePreferences((state) => state.hydrate)
  const hydrateHosts = useHosts((state) => state.hydrate)

  useEffect(() => {
    Promise.all([hydratePreferences(), hydrateHosts()])
      .catch(() => undefined)
      .finally(() => setReady(true))
  }, [hydratePreferences, hydrateHosts])

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined)
  }, [ready])

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {ready ? <ThemedApp /> : <View style={{ flex: 1 }} />}
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

function ThemedApp() {
  const { colors, scheme } = useTheme()
  const navigationState = useRootNavigationState()
  const initialHandled = useRef(false)

  useEffect(() => {
    if (!navigationState?.key) return

    const handleUrl = (value: string | null) => {
      if (!value) return
      if (value.startsWith("ocremote://pair") || value.startsWith("ocremote://p/")) {
        router.push({ pathname: "/hosts/add", params: { url: value } })
      }
    }

    if (!initialHandled.current) {
      initialHandled.current = true
      void Linking.getInitialURL().then(handleUrl)
    }

    const subscription = Linking.addEventListener("url", (event) => handleUrl(event.url))
    return () => subscription.remove()
  }, [navigationState?.key])

  return (
    <>
      <StatusBar
        barStyle={scheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={colors.bg}
      />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      />
    </>
  )
}
