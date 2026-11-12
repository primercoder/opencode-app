import { installRuntimePolyfills } from "@/polyfills"

installRuntimePolyfills()

import { router, Stack, useRootNavigationState } from "expo-router"
import { useEffect, useRef } from "react"
import { Linking, StatusBar } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { colors } from "@/theme"

export default function RootLayout() {
  const navigationState = useRootNavigationState()
  const initialHandled = useRef(false)

  useEffect(() => {
    if (!navigationState?.key) return

    const handleUrl = (value: string | null) => {
      if (!value) return
      if (value.startsWith("ocremote://pair")) {
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
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </SafeAreaProvider>
  )
}
