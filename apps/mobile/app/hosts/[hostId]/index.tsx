import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { ensureConnection, refreshInfo } from "@/transport/runtimes"
import { useForeground } from "@/lib/useForeground"
import { colors, radius, spacing } from "@/theme"

export default function HostHomeScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string }>()
  const hostId = params.hostId
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  useEffect(() => {
    useForeground(
    useCallback(() => {
      if (!host) return
      void ensureConnection(host.id, { force: true })
        .then(() => refreshInfo(host.id))
        .catch(() => undefined)
    }, [host?.id]),
  )

  if (!hydrated) {
      void hydrate()
      return
    }
    if (!host) return
    void ensureConnection(host.id).catch(() => {
      // The connection store carries the error for the UI.
    })
  }, [hydrated, host?.id, hydrate])

  useForeground(
    useCallback(() => {
      if (!host) return
      void ensureConnection(host.id, { force: true })
        .then(() => refreshInfo(host.id))
        .catch(() => undefined)
    }, [host?.id]),
  )

  if (!hydrated) {
    return <View style={styles.screen} />
  }

  if (!host) {
    return (
      <View style={[styles.screen, styles.centered, { paddingTop: insets.top }]}>
        <Text style={styles.emptyTitle}>主机不存在</Text>
        <Text style={styles.emptyBody}>它可能已从本机移除。</Text>
        <View style={styles.centeredAction}>
          <Button label="返回主机列表" onPress={() => router.replace("/")} />
        </View>
      </View>
    )
  }

  const status = connection?.status ?? "idle"
  const ready = status === "ready"
  const connecting = status === "connecting" || status === "handshaking" || status === "authenticating" || status === "reconnecting"

  const retry = () => {
    setRefreshError(null)
    void ensureConnection(host.id, { force: true }).catch(() => undefined)
  }

  const refresh = async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      if (!ready) await ensureConnection(host.id, { force: true })
      await refreshInfo(host.id)
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : "刷新失败")
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.replace("/")} style={styles.back}>
          <Text style={styles.backText}>‹ 主机</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.hostName} numberOfLines={1}>
            {host.name}
          </Text>
          <View style={styles.statusLine}>
            <View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
            <Text style={styles.statusText}>{statusLabel(status)}</Text>
          </View>
        </View>
        <View style={styles.back} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.text} />}
      >
        <View style={styles.hero}>
          <Text style={styles.heroGlyph}>⌘</Text>
          <Text style={styles.heroTitle}>{ready ? "已经连接到主机" : connecting ? "正在连接主机…" : "主机未连接"}</Text>
          <Text style={styles.heroBody}>
            {ready
              ? "选择会话开始工作，或从电脑上继续。所有内容都经过端到端加密。"
              : status === "error"
                ? connection?.error?.message ?? "无法连接到主机。"
                : "正在建立加密通道并验证主机身份。"}
          </Text>

          {status === "error" ? (
            <View style={styles.heroAction}>
              <Button label="重试连接" onPress={retry} />
            </View>
          ) : (
            <View style={styles.heroActions}>
              <Button
                label="打开会话"
                onPress={() => router.push({ pathname: "/hosts/[hostId]/sessions", params: { hostId: host.id } })}
                disabled={!ready}
              />
              <Button
                label="新建会话"
                variant="outline"
                onPress={() => router.push({ pathname: "/hosts/[hostId]/sessions", params: { hostId: host.id, new: "1" } })}
                disabled={!ready}
              />
            </View>
          )}
        </View>

        <View style={styles.card}>
          <InfoRow label="opencode" value={connection?.session?.opencode.version ?? (ready ? "2.x" : "—")} />
          <InfoRow label="连接" value={transportLabel(connection?.transport)} />
          <InfoRow label="延迟" value={connection?.latencyMs !== undefined ? `${connection.latencyMs} ms` : "—"} />
          <InfoRow
            label="最近同步"
            value={connection?.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleTimeString() : "—"}
          />
          <InfoRow label="主机指纹" value={formatFingerprint(host.fingerprint)} mono />
        </View>

        {refreshError ? <Text style={styles.error}>{refreshError}</Text> : null}

        <Text style={styles.footnote}>端到端加密 · 中继只能看到密文</Text>
      </ScrollView>
    </View>
  )
}

function InfoRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{props.label}</Text>
      <Text style={[styles.infoValue, props.mono && styles.infoValueMono]} numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  )
}

function statusColor(status: string): string {
  if (status === "ready") return colors.success
  if (status === "error") return colors.danger
  if (status === "connecting" || status === "handshaking" || status === "authenticating" || status === "reconnecting") {
    return colors.accent
  }
  return colors.faint
}

function statusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "在线"
    case "error":
      return "离线"
    case "connecting":
    case "handshaking":
    case "authenticating":
      return "连接中"
    case "reconnecting":
      return "重连中"
    default:
      return "未连接"
  }
}

function transportLabel(transport: string | undefined): string {
  if (transport === "lan") return "局域网"
  if (transport === "relay") return "中继"
  if (transport === "custom") return "自定义"
  return "—"
}

function formatFingerprint(value: string): string {
  return value.toUpperCase().match(/.{1,4}/gu)?.join(" ") ?? value.toUpperCase()
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  centered: { alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.lg,
  },
  back: { width: 64 },
  backText: { fontSize: 15, color: colors.muted },
  headerCenter: { flex: 1, alignItems: "center" },
  hostName: { fontSize: 18, fontWeight: "600", color: colors.text },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 12, color: colors.muted },
  content: { paddingBottom: spacing.xxl },
  hero: {
    alignItems: "center",
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroGlyph: { fontSize: 40, color: colors.accent, marginBottom: spacing.md },
  heroTitle: { fontSize: 20, fontWeight: "600", color: colors.text },
  heroBody: {
    marginTop: spacing.sm,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    maxWidth: 300,
  },
  heroAction: { marginTop: spacing.lg },
  heroActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg, flexWrap: "wrap", justifyContent: "center" },
  card: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    gap: spacing.lg,
  },
  infoLabel: { fontSize: 13, color: colors.muted },
  infoValue: { flex: 1, textAlign: "right", fontSize: 14, color: colors.text, fontWeight: "500" },
  infoValueMono: { fontSize: 12, letterSpacing: 0.6 },
  error: { marginTop: spacing.md, fontSize: 13, color: colors.danger, textAlign: "center" },
  footnote: { marginTop: spacing.xl, textAlign: "center", fontSize: 12, color: colors.faint },
  emptyTitle: { fontSize: 20, fontWeight: "500", color: colors.text },
  emptyBody: { marginTop: spacing.sm, fontSize: 14, color: colors.muted },
  centeredAction: { marginTop: spacing.xl },
})
