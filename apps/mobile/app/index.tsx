import { router } from "expo-router"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { useHosts } from "@/stores/hosts"
import { colors, radius, spacing } from "@/theme"

export default function HostListScreen() {
  const insets = useSafeAreaInsets()
  const hosts = useHosts((state) => state.hosts)

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Text style={styles.title}>主机</Text>
        <Button label="添加主机" onPress={() => router.push("/hosts/add")} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {hosts.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⌁</Text>
            <Text style={styles.emptyTitle}>还没有主机</Text>
            <Text style={styles.emptyBody}>
              在电脑上运行 opencode 和 ocremote-host，然后扫码或粘贴配对链接。
            </Text>
            <Text style={styles.security}>端到端加密，中继无法读取你的代码或对话。</Text>
          </View>
        ) : (
          hosts.map((host) => (
            <View key={host.id} style={styles.row}>
              <View style={styles.status} />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{host.name}</Text>
                <Text style={styles.rowMeta}>
                  {host.transports.map((transport) => transport.kind).join(" · ")}
                  {host.lastConnectedAt ? ` · ${new Date(host.lastConnectedAt).toLocaleString()}` : ""}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.lg,
  },
  title: { fontSize: 28, fontWeight: "600", color: colors.text },
  content: { paddingBottom: spacing.xxl },
  empty: {
    marginTop: spacing.xxl * 2,
    alignItems: "center",
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: { fontSize: 44, color: colors.accent, marginBottom: spacing.md },
  emptyTitle: { fontSize: 20, fontWeight: "500", color: colors.text },
  emptyBody: {
    marginTop: spacing.sm,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
  },
  security: { marginTop: spacing.lg, fontSize: 12, color: colors.faint, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  status: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.faint, marginRight: spacing.md },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: "500", color: colors.text },
  rowMeta: { marginTop: 2, fontSize: 13, color: colors.muted },
  chevron: { fontSize: 24, color: colors.faint },
})
