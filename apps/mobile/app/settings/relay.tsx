import { router } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { Button, Card, IconButton } from "@/components/ui"
import { useT } from "@/i18n"
import { listRelayAccess, removeRelayAccess, type RelayAccessSummary } from "@/storage/relay"
import { useForeground } from "@/lib/useForeground"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

export default function RelayAccessScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(relayStyles)
  const [items, setItems] = useState<RelayAccessSummary[] | null>(null)

  const reload = useCallback(async () => {
    setItems(await listRelayAccess())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])
  useForeground(useCallback(() => void reload(), [reload]))

  const remove = (item: RelayAccessSummary) => {
    Alert.alert(t("relayRemove"), t("relayRemoveBody"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("relayRemove"),
        style: "destructive",
        onPress: () => {
          void removeRelayAccess(item.url).then(reload)
        },
      },
    ])
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <IconButton label={t("back")} onPress={() => router.back()}>
          <Icon name="back" size={22} color={colors.text} />
        </IconButton>
        <Text style={styles.title}>{t("relayAccessTitle")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.hint}>{t("relayViewNote")}</Text>
        {items === null ? null : items.length === 0 ? (
          <Text style={[styles.hint, { marginTop: 20 }]}>{t("relayNoAccess")}</Text>
        ) : (
          <>
            <Text style={styles.count}>{t("relayBound", { n: items.length })}</Text>
            {items.map((item) => (
              <Card key={item.url} style={{ marginBottom: 10 }}>
                <View style={styles.row}>
                  <View style={[styles.icon, { backgroundColor: colors.surface2 }]}>
                    <Icon name="globe" size={17} color={colors.muted} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.url} numberOfLines={1}>
                      {item.url}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {item.subjectId}
                      {item.room ? ` · ${item.room}` : ""}
                    </Text>
                  </View>
                  <Button label={t("relayRemove")} size="sm" variant="outline" onPress={() => remove(item)} style={{ borderColor: colors.danger }} />
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  )
}

const relayStyles = (colors: Palette) =>
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
    hint: { fontSize: 11.5, lineHeight: 17, color: colors.faint, marginTop: 12, paddingHorizontal: 2 },
    count: { fontSize: 11, fontWeight: "600", color: colors.faint, marginTop: 18, marginBottom: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
    icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    url: { fontSize: 13, fontWeight: "600", color: colors.text, fontFamily: "monospace" },
    meta: { fontSize: 11, color: colors.faint, marginTop: 3 },
  })
