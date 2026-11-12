import "@/polyfills"
import { Stack } from "expo-router"
import { StatusBar } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { colors } from "@/theme"

export default function RootLayout() {
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
