import { router } from "expo-router"
import { StyleSheet, Text, View } from "react-native"
import { Button } from "@/components/ui"
import { useT } from "@/i18n"
import { useTheme } from "@/theme"

/**
 * The root layout intercepts `ocremote://pair#...` links and replaces this
 * placeholder with the add-host screen. If the link cannot be handled (for
 * example when it is opened while the app is already running), this route
 * stays visible as a fallback instead of rendering a blank page.
 */
export default function PairLinkRoute() {
  const { colors } = useTheme()
  const t = useT()
  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Text style={[styles.hint, { color: colors.muted }]}>{t("pairLinkProblem")}</Text>
      <View style={styles.actions}>
        <Button label={t("backToHosts")} onPress={() => router.replace("/")} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  hint: { fontSize: 14, textAlign: "center", lineHeight: 21 },
  actions: { marginTop: 18 },
})
