import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { OpencodeClient, type FileDiff } from "@/opencode/client"
import { parsePatch, type DiffLineKind } from "@/opencode/diff"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { ensureConnection } from "@/transport/runtimes"
import { useT } from "@/i18n"
import { radius, spacing, useTheme, useThemedStyles, type Palette } from "@/theme"

export default function SessionDiffScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(diffStyles)
  const params = useLocalSearchParams<{ hostId: string; sessionId: string }>()
  const { hostId, sessionId } = params
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null)
  const [visibleFiles, setVisibleFiles] = useState(6)
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
      setVisibleFiles(6)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    }
  }, [hostId, sessionId, t])

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
          <Text style={styles.backText}>‹ {t("sessions")}</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>{t("diffTitle")}</Text>
          {diffs ? (
            <Text style={styles.subtitle}>
              {t("diffSummary")} <Text style={styles.add}>+{additions}</Text> <Text style={styles.del}>−{deletions}</Text>
            </Text>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" onPress={() => void refresh()} style={[styles.back, styles.refresh]}>
          <Text style={styles.backText}>{t("refresh")}</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.text} />}
      >
        {!connection || connection.status === "error" ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>{t("notConnectedShort")}</Text>
            <Text style={styles.noticeBody}>{connection?.error?.message ?? t("returnToSession")}</Text>
            <View style={styles.noticeAction}>
              <Button label={t("retry")} onPress={() => void ensureConnection(hostId, { force: true }).catch(() => undefined)} />
            </View>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {diffs === null ? <Text style={styles.loading}>{t("loadingDiff")}</Text> : null}
        {diffs?.length === 0 ? <Text style={styles.loading}>{t("diffEmpty")}</Text> : null}
        {diffs?.slice(0, visibleFiles).map((diff) => <DiffCard key={diff.file} diff={diff} />)}
        {diffs && diffs.length > visibleFiles ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setVisibleFiles((current) => current + 6)}
            style={{ alignSelf: "center", paddingVertical: 10, paddingHorizontal: 14 }}
          >
            <Text style={{ fontSize: 13, color: colors.accent, fontWeight: "600" }}>
              {t("showMoreFiles", { n: diffs.length - visibleFiles })}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  )
}

function DiffCard(props: { diff: FileDiff }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(diffStyles)
  const t = useT()
  const [limit, setLimit] = useState(200)
  const lines = parsePatch(props.diff.patch)
  const visible = lines.slice(0, limit)
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
            <View key={index} style={[styles.lineRow, lineBackground(line.kind, styles)]}>
              <Text style={styles.oldLineNumber}>{line.oldLine ?? ""}</Text>
              <Text style={styles.newLineNumber}>{line.newLine ?? ""}</Text>
              <Text style={[styles.line, lineStyle(line.kind, styles)]}>{line.text.length > 0 ? line.text : " "}</Text>
            </View>
          ))}
          {lines.length > visible.length ? (
            <Text style={styles.truncated}>…</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  )
}

function lineStyle(kind: DiffLineKind, styles: ReturnType<typeof diffStyles>) {
  if (kind === "meta") return styles.lineMeta
  if (kind === "hunk") return styles.lineHunk
  if (kind === "add") return styles.lineAdd
  if (kind === "del") return styles.lineDel
  return undefined
}

function lineBackground(kind: DiffLineKind, styles: ReturnType<typeof diffStyles>) {
  if (kind === "hunk") return styles.rowHunk
  if (kind === "add") return styles.rowAdd
  if (kind === "del") return styles.rowDel
  return undefined
}

const mono = { fontFamily: "monospace" as const }

const diffStyles = (colors: Palette) =>
  StyleSheet.create({
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
  lineRow: { flexDirection: "row", minHeight: 17 },
  rowHunk: { backgroundColor: "rgba(59,92,246,0.08)" },
  rowAdd: { backgroundColor: "rgba(25,139,67,0.10)" },
  rowDel: { backgroundColor: "rgba(217,46,60,0.10)" },
  oldLineNumber: {
    width: 42,
    paddingRight: 5,
    textAlign: "right",
    fontSize: 10,
    lineHeight: 17,
    color: colors.faint,
    ...mono,
  },
  newLineNumber: {
    width: 42,
    paddingRight: spacing.sm,
    textAlign: "right",
    fontSize: 10,
    lineHeight: 17,
    color: colors.faint,
    ...mono,
  },
  line: { fontSize: 11, lineHeight: 17, color: colors.text, ...mono, paddingRight: spacing.md },
  lineMeta: { color: colors.faint, fontWeight: "600" },
  lineHunk: { color: colors.accent },
  lineAdd: { color: colors.success },
  lineDel: { color: colors.danger },
  truncated: { padding: spacing.md, fontSize: 12, color: colors.faint },
})
