import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { OpencodeClient, type FileDiff } from "@/opencode/client"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { ensureConnection } from "@/transport/runtimes"
import { colors, radius, spacing } from "@/theme"

export default function SessionDiffScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string; sessionId: string }>()
  const { hostId, sessionId } = params
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!hydrated) {
      void hydrate()
      return
    }
    void ensureConnection(hostId).catch(() => undefined)
  }, [hydrated, hydrate, hostId])

  const load = useCallback(async () => {
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      setDiffs(await new OpencodeClient(runtime).sessionDiff(sessionId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载 Diff 失败")
    }
  }, [hostId, sessionId])

  useEffect(() => {
    if (connection?.status !== "ready" || diffs !== null) return
    void load()
  }, [connection?.status, diffs, load])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const additions = diffs?.reduce((total, diff) => total + diff.additions, 0) ?? 0
  const deletions = diffs?.reduce((total, diff) => total + diff.deletions, 0) ?? 0

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ 会话</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>本轮 Diff</Text>
          {diffs ? (
            <Text style={styles.subtitle}>
              最后修改 <Text style={styles.add}>+{additions}</Text> <Text style={styles.del}>−{deletions}</Text>
            </Text>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" onPress={() => void refresh()} style={[styles.back, styles.refresh]}>
          <Text style={styles.backText}>刷新</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.text} />}
      >
        {!connection || connection.status === "error" ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>主机未连接</Text>
            <Text style={styles.noticeBody}>{connection?.error?.message ?? "请先返回会话并重试"}</Text>
            <View style={styles.noticeAction}>
              <Button label="重试" onPress={() => void ensureConnection(hostId, { force: true }).catch(() => undefined)} />
            </View>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {diffs === null ? <Text style={styles.loading}>正在加载 Diff…</Text> : null}
        {diffs?.length === 0 ? <Text style={styles.loading}>本轮没有文件改动。</Text> : null}
        {diffs?.map((diff) => <DiffCard key={diff.file} diff={diff} />)}
      </ScrollView>
    </View>
  )
}

function DiffCard(props: { diff: FileDiff }) {
  const lines = props.diff.patch.split("\n")
  const visible = lines.length > 1500 ? lines.slice(0, 1500) : lines
  return (
    <View style={styles.fileCard}>
      <View style={styles.fileHeader}>
        <Text style={styles.fileName} numberOfLines={1}>
          {props.diff.file}
        </Text>
        <Text style={styles.fileStat}>
          <Text style={styles.add}>+{props.diff.additions}</Text> <Text style={styles.del}>−{props.diff.deletions}</Text>
        </Text>
      </View>
      <ScrollView horizontal contentContainerStyle={styles.patchScroll} showsHorizontalScrollIndicator={false}>
        <View>
          {visible.map((line, index) => (
            <Text key={index} style={[styles.line, lineStyle(line)]}>
              {line.length > 0 ? line : " "}
            </Text>
          ))}
          {lines.length > visible.length ? (
            <Text style={styles.truncated}>已省略 {lines.length - visible.length} 行，请在电脑上查看完整 Diff。</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  )
}

function lineStyle(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return styles.lineMeta
  if (line.startsWith("@@")) return styles.lineHunk
  if (line.startsWith("+")) return styles.lineAdd
  if (line.startsWith("-")) return styles.lineDel
  return undefined
}

const mono = { fontFamily: "monospace" as const }

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: { width: 64 },
  refresh: { alignItems: "flex-end" },
  backText: { fontSize: 15, color: colors.muted },
  headerCenter: { flex: 1, alignItems: "center" },
  title: { fontSize: 16, fontWeight: "600", color: colors.text },
  subtitle: { marginTop: 2, fontSize: 11, color: colors.muted },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  notice: {
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noticeTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  noticeBody: { marginTop: 4, fontSize: 13, color: colors.muted },
  noticeAction: { marginTop: spacing.md, alignItems: "flex-start" },
  error: { fontSize: 13, color: colors.danger },
  loading: { textAlign: "center", fontSize: 13, color: colors.faint, marginTop: spacing.lg },
  fileCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  fileName: { flex: 1, fontSize: 13, fontWeight: "500", color: colors.text, ...mono },
  fileStat: { fontSize: 12, color: colors.muted },
  add: { color: colors.success },
  del: { color: colors.danger },
  patchScroll: { paddingVertical: spacing.xs },
  line: { fontSize: 11, lineHeight: 17, color: colors.text, ...mono, paddingHorizontal: spacing.sm },
  lineMeta: { color: colors.faint, fontWeight: "600" },
  lineHunk: { color: colors.accent, backgroundColor: "rgba(59,92,246,0.08)" },
  lineAdd: { color: "#0B6B32", backgroundColor: "rgba(25,139,67,0.10)" },
  lineDel: { color: "#9B1C28", backgroundColor: "rgba(217,46,60,0.10)" },
  truncated: { padding: spacing.md, fontSize: 12, color: colors.faint },
})
