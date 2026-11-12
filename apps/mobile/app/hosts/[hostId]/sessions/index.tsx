import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import {
  OpencodeClient,
  sessionBusy,
  sessionUpdatedAt,
  type SessionInfo,
} from "@/opencode/client"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { ensureConnection } from "@/transport/runtimes"
import { colors, radius, spacing } from "@/theme"

export default function SessionsScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string; new?: string }>()
  const hostId = params.hostId
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const creating = useRef(false)

  useEffect(() => {
    if (!hydrated) {
      void hydrate()
      return
    }
    if (!host) return
    void ensureConnection(host.id).catch(() => undefined)
  }, [hydrated, host?.id, hydrate])

  const load = useCallback(async () => {
    if (!hostId) return
    setLoading(true)
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const page = await new OpencodeClient(runtime).listSessions({ limit: 50, order: "desc" })
      setSessions(page.data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载会话失败")
    } finally {
      setLoading(false)
    }
  }, [hostId])

  useEffect(() => {
    if (connection?.status !== "ready") return
    if (sessions !== null) return
    void load()
  }, [connection?.status, sessions, load])

  const createSession = useCallback(async () => {
    if (!hostId || creating.current) return
    creating.current = true
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const session = await new OpencodeClient(runtime).createSession()
      setSessions((current) => [session, ...(current ?? []).filter((item) => item.id !== session.id)])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新建会话失败")
    } finally {
      creating.current = false
    }
  }, [hostId])

  useEffect(() => {
    if (params.new !== "1" || connection?.status !== "ready") return
    void createSession()
  }, [params.new, connection?.status, createSession])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const ready = connection?.status === "ready"

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.back}
        >
          <Text style={styles.backText}>‹ 主机</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>所有会话</Text>
          <Text style={styles.subtitle}>{host?.name ?? "主机"}</Text>
        </View>
        <View style={styles.back} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.text} />}
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          <Button label="新建会话" onPress={() => void createSession()} disabled={!ready} />
        </View>

        {!ready && connection?.status === "error" ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>主机离线</Text>
            <Text style={styles.noticeBody}>{connection.error?.message ?? "无法连接主机"}</Text>
            <View style={styles.noticeAction}>
              <Button label="重试" onPress={() => void ensureConnection(hostId, { force: true }).catch(() => undefined)} />
            </View>
          </View>
        ) : null}

        {loading && sessions === null ? <Text style={styles.loading}>正在加载会话…</Text> : null}

        {sessions?.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>还没有会话</Text>
            <Text style={styles.emptyBody}>新建一个会话，从手机上开始工作。</Text>
          </View>
        ) : null}

        {sessions?.map((session) => (
          <Pressable
            key={session.id}
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: "/hosts/[hostId]/sessions/[sessionId]",
                params: { hostId, sessionId: session.id },
              })
            }
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={[styles.status, { backgroundColor: sessionBusy(session) ? colors.accent : colors.border }]} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {session.title?.trim() || "未命名会话"}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {session.location?.directory ?? session.projectID ?? "opencode"}
                {sessionUpdatedAt(session) ? ` · ${relativeTime(sessionUpdatedAt(session))}` : ""}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return "刚刚"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: spacing.lg },
  back: { width: 64 },
  backText: { fontSize: 15, color: colors.muted },
  headerCenter: { flex: 1, alignItems: "center" },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  subtitle: { marginTop: 2, fontSize: 12, color: colors.muted },
  content: { paddingBottom: spacing.xxl },
  actions: { marginBottom: spacing.lg, alignItems: "flex-start" },
  error: { marginBottom: spacing.md, fontSize: 13, color: colors.danger },
  loading: { marginTop: spacing.lg, fontSize: 14, color: colors.muted, textAlign: "center" },
  notice: {
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noticeTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  noticeBody: { marginTop: 4, fontSize: 13, color: colors.muted, lineHeight: 19 },
  noticeAction: { marginTop: spacing.md, alignItems: "flex-start" },
  empty: { marginTop: spacing.xxl, alignItems: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "500", color: colors.text },
  emptyBody: { marginTop: spacing.sm, fontSize: 14, color: colors.muted },
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
  status: { width: 7, height: 7, borderRadius: 4, marginRight: spacing.md },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: "500", color: colors.text },
  rowMeta: { marginTop: 3, fontSize: 12, color: colors.muted },
  chevron: { fontSize: 22, color: colors.faint, marginLeft: spacing.sm },
})
