import { router } from "expo-router"
import { useEffect } from "react"
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { useConnections, type HostConnection } from "@/stores/connections"
import { useHosts, type HostRecord } from "@/stores/hosts"
import { colors, radius, spacing } from "@/theme"

export default function HostListScreen() {
  const insets = useSafeAreaInsets()
  const hosts = useHosts((state) => state.hosts)
  const hydrate = useHosts((state) => state.hydrate)
  const removeHost = useHosts((state) => state.removeHost)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const hostMenu = (host: HostRecord) => {
    Alert.alert(host.name, "管理这台主机", [
      { text: "取消", style: "cancel" },
      { text: "编辑", onPress: () => router.push({ pathname: "/hosts/[hostId]/edit", params: { hostId: host.id } }) },
      { text: "移除", style: "destructive", onPress: () => void removeHost(host.id) },
    ])
  }

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
            <Text style={styles.emptyBody}>在电脑上运行 opencode 和 ocremote-host，然后扫码或粘贴配对链接。</Text>
            <Text style={styles.security}>端到端加密，中继无法读取你的代码或对话。</Text>
          </View>
        ) : (
          hosts.map((host) => <HostRow key={host.id} host={host} onLongPress={() => hostMenu(host)} />)
        )}
      </ScrollView>
    </View>
  )
}

function HostRow(props: { host: HostRecord; onLongPress: () => void }) {
  const connection = useConnections((state) => state.byHost[props.host.id])
  const status = statusOf(connection)
  const transport = connection?.transport ?? props.host.lastTransport

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.host.name}，${status.label}`}
      onLongPress={props.onLongPress}
      onPress={() => router.push({ pathname: "/hosts/[hostId]", params: { hostId: props.host.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.status, { backgroundColor: status.color }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {props.host.name}
          </Text>
          <Text style={styles.badge}>{transportLabel(transport)}</Text>
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {status.label}
          {connection?.error ? ` · ${connection.error.message}` : ""}
          {!connection && props.host.lastConnectedAt ? ` · ${relativeTime(props.host.lastConnectedAt)}` : ""}
        </Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  )
}

function statusOf(connection: HostConnection | undefined): { label: string; color: string } {
  if (!connection || connection.status === "idle") return { label: "未连接", color: colors.faint }
  switch (connection.status) {
    case "connecting":
    case "handshaking":
    case "authenticating":
    case "reconnecting":
      return { label: "连接中", color: colors.accent }
    case "ready":
      return { label: "已加密 · 在线", color: colors.success }
    case "error":
      return { label: "连接失败", color: colors.danger }
    case "closed":
      return { label: "已断开", color: colors.faint }
    default:
      return { label: "未知", color: colors.faint }
  }
}

function transportLabel(transport: string | undefined): string {
  if (transport === "relay") return "中继"
  if (transport === "custom") return "自定义"
  if (transport === "lan") return "局域网"
  return "待连接"
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return "刚刚"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
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
  rowPressed: { opacity: 0.7 },
  status: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.md },
  rowBody: { flex: 1 },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  rowTitle: { flex: 1, fontSize: 16, fontWeight: "500", color: colors.text },
  badge: { fontSize: 11, color: colors.muted, fontWeight: "500" },
  rowMeta: { marginTop: 3, fontSize: 13, color: colors.muted },
  chevron: { fontSize: 24, color: colors.faint, marginLeft: spacing.sm },
})
