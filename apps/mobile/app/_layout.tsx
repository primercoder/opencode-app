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

/**
 * Deep links such as `ocremote://pair#...` land directly on `/pair`. Keeping the
 * host list as the stack anchor means backing out of the workspace returns to
 * the host list instead of an empty pair placeholder.
 */
export const unstable_settings = { anchor: "index" }

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

    const isPairLink = (value: string) =>
      value.startsWith("ocremote://pair") || value.startsWith("ocremote://p/")

    const handleUrl = (value: string | null) => {
      if (!value || !isPairLink(value)) return
      // Expo Router first opens the `/pair` placeholder for these links. Replace
      // it so the add-host screen sits directly on the host list anchor instead
      // of leaving a blank page underneath the workspace.
      router.replace({ pathname: "/hosts/add", params: { url: value } })
    }

    if (!initialHandled.current) {
      initialHandled.current = true
      void Linking.getInitialURL().then((value) => {
        if (!value) return
        if (value.startsWith("ocremote://pair") || value.startsWith("ocremote://p/")) {
          // Replace the `/pair` placeholder so the add-host screen sits directly
          // on the host list anchor.
          router.replace({ pathname: "/hosts/add", params: { url: value } })
        }
      })
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
