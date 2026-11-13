import Constants from "expo-constants"
import { router } from "expo-router"
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { Card, Divider, IconButton, SectionLabel, Segmented } from "@/components/ui"
import { useT } from "@/i18n"
import { usePreferences, type Language } from "@/stores/preferences"
import { saveVoiceEnginePreference } from "@/features/voice/preferences"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

export default function SettingsScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(settingsStyles)
  const themeMode = usePreferences((state) => state.themeMode)
  const language = usePreferences((state) => state.language)
  const notifications = usePreferences((state) => state.notifications)
  const voiceEngine = usePreferences((state) => state.voiceEngine)
  const setThemeMode = usePreferences((state) => state.setThemeMode)
  const setLanguage = usePreferences((state) => state.setLanguage)
  const setNotifications = usePreferences((state) => state.setNotifications)
  const setVoiceEngine = usePreferences((state) => state.setVoiceEngine)

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <IconButton label={t("back")} onPress={() => router.back()}>
          <Icon name="back" size={22} color={colors.text} />
        </IconButton>
        <Text style={styles.title}>{t("generalSettings")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <SectionLabel>{t("appearance")}</SectionLabel>
        <Segmented
          value={themeMode}
          options={[
            { value: "system", label: t("themeSystem") },
            { value: "light", label: t("themeLight") },
            { value: "dark", label: t("themeDark") },
          ]}
          onChange={(value) => void setThemeMode(value)}
        />

        <SectionLabel>{t("language")}</SectionLabel>
        <Segmented
          value={language}
          options={[
            { value: "zh", label: t("chinese") },
            { value: "en", label: t("english") },
          ]}
          onChange={(value) => void setLanguage(value as Language)}
        />

        <SectionLabel>{t("notifications")}</SectionLabel>
        <Card>
          <View style={styles.row}>
            <Icon name="bell" size={18} color={colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{t("notifications")}</Text>
              <Text style={styles.rowBody}>{t("notificationsHint")}</Text>
            </View>
            <Switch
              value={notifications}
              onValueChange={(value) => void setNotifications(value)}
              trackColor={{ false: colors.surface2, true: colors.accent }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        <SectionLabel>{t("voice")}</SectionLabel>
        <Text style={styles.hint}>{t("engineAutoHint")}</Text>
        <Segmented
          value={voiceEngine}
          options={[
            { value: "auto", label: t("engineAuto") },
            { value: "local", label: t("engineLocal") },
            { value: "host", label: t("engineHost") },
            { value: "system", label: t("engineSystem") },
          ]}
          onChange={(value) => {
            void setVoiceEngine(value)
            void saveVoiceEnginePreference(value)
          }}
        />

        <Card style={{ marginTop: 12 }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/settings/voice")}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            <Icon name="mic" size={18} color={colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{t("voiceModels")}</Text>
              <Text style={styles.rowBody}>{t("phoneModelHint")}</Text>
            </View>
            <Icon name="chevronRight" size={16} color={colors.faint} />
          </Pressable>
          <Divider inset={46} />
          <View style={styles.row}>
            <Icon name="server" size={18} color={colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{t("hostModel")}</Text>
              <Text style={styles.rowBody}>{t("hostModelHint")}</Text>
            </View>
          </View>
        </Card>

        <SectionLabel>{t("about")}</SectionLabel>
        <Card>
          <View style={styles.row}>
            <Icon name="lock" size={18} color={colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{t("appName")}</Text>
              <Text style={styles.rowBody}>
                {t("version")} {Constants.expoConfig?.version ?? "0.1.0"}
              </Text>
            </View>
          </View>
          <Divider inset={46} />
          <View style={{ paddingHorizontal: 18, paddingVertical: 14 }}>
            <Text style={styles.rowBody}>{t("securityNote")}</Text>
          </View>
        </Card>
      </ScrollView>
    </View>
  )
}

const settingsStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 8,
      paddingBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    title: { fontSize: 17, fontWeight: "700", color: colors.text },
    content: { paddingHorizontal: 16, paddingBottom: 40 },
    row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
    rowTitle: { fontSize: 14.5, fontWeight: "500", color: colors.text },
    rowBody: { fontSize: 11.5, lineHeight: 17, color: colors.faint, marginTop: 3 },
    hint: { fontSize: 11.5, lineHeight: 17, color: colors.faint, marginBottom: 8, paddingHorizontal: 2 },
  })
