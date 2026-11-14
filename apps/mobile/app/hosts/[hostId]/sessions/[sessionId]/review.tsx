import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { FileTypeIcon } from "@/components/FileTypeIcon"
import { OpencodeClient, type FsEntry, type SessionInfo } from "@/opencode/client"
import { buildReviewPrompt, selectionRange, type ReviewComment } from "@/opencode/review"
import { isProbablyBinary } from "@/opencode/fileKind"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { ensureConnection } from "@/transport/runtimes"
import { useT } from "@/i18n"
import { radius, spacing, useTheme, useThemedStyles, type Palette } from "@/theme"

type OpenFile = {
  path: string
  lines: string[]
  binary: boolean
}

export default function ReviewScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(reviewStyles)
  const params = useLocalSearchParams<{ hostId: string; sessionId: string; directory?: string }>()
  const { hostId, sessionId } = params
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const [directory, setDirectory] = useState(params.directory ?? "")
  const [currentPath, setCurrentPath] = useState("")
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [file, setFile] = useState<OpenFile | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  const [draft, setDraft] = useState("")
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootGesture = useRef({ x: 0, scrolled: false })

  useEffect(() => {
    if (!hydrated) {
      void hydrate()
      return
    }
    void ensureConnection(hostId).catch(() => undefined)
  }, [hydrated, hydrate, hostId])

  useEffect(() => {
    if (directory || connection?.status !== "ready") return
    void ensureConnection(hostId)
      .then((runtime) => new OpencodeClient(runtime).getSession(sessionId))
      .then((session: SessionInfo) => {
        const value = session.location?.directory
        if (value) setDirectory(value)
        else setError("会话没有项目目录")
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法读取会话目录"))
  }, [directory, connection?.status, hostId, sessionId])

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!directory) return
      setLoading(true)
      setError(null)
      try {
        const runtime = await ensureConnection(hostId)
        const list = await new OpencodeClient(runtime).listFiles(directory, path || undefined)
        setEntries(sortEntries(list))
        setCurrentPath(path)
        setFile(null)
        setAnchor(null)
        setRange(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "读取目录失败")
      } finally {
        setLoading(false)
      }
    },
    [directory, hostId],
  )

  useEffect(() => {
    if (connection?.status !== "ready" || !directory || entries !== null) return
    void loadDirectory("")
  }, [connection?.status, directory, entries, loadDirectory])

  const openFile = async (entry: FsEntry) => {
    if (!directory) return
    setLoading(true)
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const result = await new OpencodeClient(runtime).readFile(directory, entry.path)
      // Extensions take precedence over MIME: `.ts` is often reported as
      // video/mp2t even though it is a TypeScript source file.
      const binary = isProbablyBinary(result.content, result.contentType, entry.path)
      setFile({ path: entry.path, lines: result.content.split("\n"), binary })
      setAnchor(null)
      setRange(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取文件失败")
    } finally {
      setLoading(false)
    }
  }

  const selectLine = (line: number) => {
    if (anchor === null) {
      setAnchor(line)
      setRange(null)
      return
    }
    if (!range) {
      setRange(selectionRange({ start: anchor }, line))
      setAnchor(null)
      return
    }
    setAnchor(line)
    setRange(null)
  }

  const addComment = () => {
    if (!file || !range || draft.trim().length === 0) return
    const preview = file.lines
      .slice(range.start - 1, range.end)
      .join("\n")
      .slice(0, 600)
    setComments((current) => [
      ...current,
      {
        type: "file",
        path: file.path,
        selection: { startLine: range.start, endLine: range.end, startChar: 0, endChar: 0 },
        comment: draft.trim(),
        preview,
        origin: "review",
      },
    ])
    setDraft("")
    setRange(null)
    setAnchor(null)
  }

  const readOnly = connection?.session?.device?.scope === "read"

  const send = async () => {
    if (comments.length === 0 || sending || readOnly) return
    setSending(true)
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const prompt = buildReviewPrompt(directory, comments)
      await new OpencodeClient(runtime).prompt(sessionId, prompt)
      router.back()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送评论失败")
    } finally {
      setSending(false)
    }
  }

  const parentPath = currentPath.replace(/\/+$/u, "").split("/").slice(0, -1).join("/")

  const goRoot = () => {
    if (!directory) return
    if (file || currentPath) {
      setAnchor(null)
      setRange(null)
      void loadDirectory("")
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + spacing.md }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ {t("sessions")}</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>{t("reviewTitle")}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {comments.length > 0 ? `${t("commentsPending", { n: comments.length })}` : t("readOnly")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => void send()}
          disabled={comments.length === 0 || sending || readOnly}
          style={styles.send}
        >
          {sending ? <ActivityIndicator size="small" color={colors.accent} /> : <Text style={[styles.sendText, (comments.length === 0 || readOnly) && styles.sendDisabled]}>{t("send")}</Text>}
        </Pressable>
      </View>

      <View style={styles.breadcrumb}>
        <FileTypeIcon directory size={19} name={directory} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("projectRoot")}
          onPress={() => {
            if (rootGesture.current.scrolled) {
              rootGesture.current.scrolled = false
              return
            }
            goRoot()
          }}
          onTouchStart={(event) => {
            rootGesture.current = { x: event.nativeEvent.pageX, scrolled: false }
          }}
          onTouchMove={(event) => {
            if (Math.abs(event.nativeEvent.pageX - rootGesture.current.x) > 8) {
              rootGesture.current.scrolled = true
            }
          }}
          style={{ flex: 1 }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            onScrollBeginDrag={() => {
              rootGesture.current.scrolled = true
            }}
          >
            <Text style={styles.path} numberOfLines={1}>
              {directory || t("projectRoot")}
            </Text>
          </ScrollView>
        </Pressable>
        {file ? (
          <Pressable accessibilityRole="button" onPress={() => setFile(null)}>
            <Text style={styles.crumb}>{t("fileList")}</Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <View style={styles.errorRow}>
          <Text style={styles.error}>{error}</Text>
          {entries === null ? <Button label={t("retry")} variant="outline" onPress={() => void loadDirectory(currentPath)} /> : null}
        </View>
      ) : null}

      {file ? (
        <FileView file={file} range={range} anchor={anchor} onSelectLine={selectLine} />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {loading && entries === null ? <Text style={styles.loading}>{t("loading")}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !currentPath }}
            disabled={!currentPath}
            onPress={() => void loadDirectory(parentPath)}
            style={({ pressed }) => [styles.entry, !currentPath && styles.entryDisabled, pressed && currentPath && styles.entryPressed]}
          >
            <FileTypeIcon directory size={23} name={currentPath} />
            <Text style={[styles.entryName, !currentPath && styles.entryNameDisabled]}>..</Text>
            <Text style={styles.entryType}>{currentPath ? t("parentDir") : t("projectRoot")}</Text>
          </Pressable>
          {entries?.length === 0 ? <Text style={styles.loading}>{t("directoryEmpty")}</Text> : null}
          {entries?.map((entry) => (
            <Pressable
              key={entry.path}
              accessibilityRole="button"
              onPress={() => (entry.type === "directory" ? void loadDirectory(entry.path) : void openFile(entry))}
              style={({ pressed }) => [styles.entry, pressed && styles.entryPressed]}
            >
              <FileTypeIcon
                directory={entry.type === "directory"}
                name={entry.path}
                size={entry.type === "directory" ? 23 : 22}
              />
              <Text style={styles.entryName} numberOfLines={1}>
                {basename(entry.path)}
              </Text>
              <Text style={styles.entryType}>{entry.type === "directory" ? t("directory") : t("file")}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {comments.length > 0 ? (
        <ScrollView horizontal style={styles.comments} contentContainerStyle={styles.commentsContent} showsHorizontalScrollIndicator={false}>
          {comments.map((comment, index) => (
            <Pressable
              key={`${comment.path}-${comment.selection.startLine}-${index}`}
              accessibilityRole="button"
              accessibilityLabel={t("deleteComment")}
              onPress={() => setComments((current) => current.filter((_, position) => position !== index))}
              style={styles.commentChip}
            >
              <Text style={styles.commentChipText} numberOfLines={1}>
                {basename(comment.path)}:{comment.selection.startLine}–{comment.selection.endLine} ×
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {range && file ? (
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
          <Text style={styles.selection}>
            {t("lineRange", { start: range.start, end: range.end })}
          </Text>
          <TextInput
            multiline
            onChangeText={setDraft}
            placeholder={t("commentPlaceholder")}
            placeholderTextColor={colors.faint}
            style={styles.input}
            value={draft}
          />
          <Button label={t("addComment")} onPress={addComment} disabled={draft.trim().length === 0} />
        </View>
      ) : (
        <View style={[styles.hintBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
          <Text style={styles.hintText}>
            {file ? t("reviewHintStart") : t("reviewHintPick")}
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

function FileView(props: {
  file: OpenFile
  range: { start: number; end: number } | null
  anchor: number | null
  onSelectLine: (line: number) => void
}) {
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(reviewStyles)
  const [wrap, setWrap] = useState(false)
  const lines = props.file.lines.slice(0, 3000)
  const rows = (
    <View>
      {lines.map((line, index) => {
        const number = index + 1
        const selected =
          props.anchor === number ||
          (props.range !== null && number >= props.range.start && number <= props.range.end)
        return (
          <Pressable
            key={number}
            accessibilityRole="button"
            onPress={() => props.onSelectLine(number)}
            style={[styles.codeLine, wrap && styles.codeLineWrap, selected && styles.codeLineSelected]}
          >
            <Text style={styles.lineNumber}>{number}</Text>
            <Text style={[styles.code, wrap && styles.codeWrapped]}>{line.length > 0 ? line : " "}</Text>
          </Pressable>
        )
      })}
      {props.file.lines.length > lines.length ? (
        <Text style={styles.truncated}>…</Text>
      ) : null}
    </View>
  )

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.fileBar}>
        <FileTypeIcon name={props.file.path} size={18} />
        <Text style={styles.filePath} numberOfLines={1}>
          {props.file.path}
        </Text>
        {!props.file.binary ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: wrap }}
            onPress={() => setWrap((value) => !value)}
            style={[styles.wrapToggle, wrap && styles.wrapToggleOn]}
          >
            <Text style={[styles.wrapToggleText, wrap && { color: colors.accent }]}>
              {wrap ? t("textWrap") : t("noWrap")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {props.file.binary ? (
        <Text style={styles.loading}>{t("binaryPreview")}</Text>
      ) : wrap ? (
        <ScrollView style={styles.codeScroll}>{rows}</ScrollView>
      ) : (
        <ScrollView style={styles.codeScroll}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            {rows}
          </ScrollView>
        </ScrollView>
      )}
    </View>
  )
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1
    return left.path.localeCompare(right.path)
  })
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const mono = { fontFamily: "monospace" as const }

const reviewStyles = (colors: Palette) =>
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
  backText: { fontSize: 15, color: colors.muted },
  headerCenter: { flex: 1, alignItems: "center" },
  title: { fontSize: 16, fontWeight: "600", color: colors.text },
  subtitle: { marginTop: 2, fontSize: 11, color: colors.muted },
  send: { width: 64, alignItems: "flex-end" },
  sendText: { fontSize: 15, color: colors.accent, fontWeight: "600" },
  sendDisabled: { color: colors.faint, fontWeight: "400" },
  breadcrumb: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  crumb: { fontSize: 13, color: colors.accent },
  path: { fontSize: 12, color: colors.muted, ...mono },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  error: { flex: 1, fontSize: 13, color: colors.danger },
  list: { padding: spacing.md, paddingBottom: spacing.xxl },
  loading: { padding: spacing.lg, textAlign: "center", fontSize: 13, color: colors.faint },
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  entryPressed: { backgroundColor: colors.surface },
  entryDisabled: { opacity: 0.45 },
  entryName: { flex: 1, fontSize: 14, color: colors.text, ...mono },
  entryNameDisabled: { color: colors.faint },
  entryType: { fontSize: 11, color: colors.faint },
  fileBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  filePath: { flex: 1, fontSize: 11.5, color: colors.muted, ...mono },
  wrapToggle: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  wrapToggleOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  wrapToggleText: { fontSize: 11, color: colors.muted, fontWeight: "600" },
  codeScroll: { flex: 1, backgroundColor: colors.surface },
  codeLine: { flexDirection: "row", minHeight: 20 },
  codeLineWrap: { alignItems: "flex-start" },
  codeLineSelected: { backgroundColor: "rgba(59,92,246,0.12)" },
  lineNumber: { width: 48, paddingRight: spacing.sm, textAlign: "right", fontSize: 11, lineHeight: 20, color: colors.faint, ...mono },
  code: { fontSize: 11, lineHeight: 20, color: colors.text, ...mono, paddingRight: spacing.lg },
  codeWrapped: { flex: 1, flexShrink: 1, paddingRight: spacing.sm },
  truncated: { padding: spacing.md, fontSize: 12, color: colors.faint },
  comments: { maxHeight: 40, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  commentsContent: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, alignItems: "center" },
  commentChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  commentChipText: { fontSize: 12, color: colors.text },
  composer: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  selection: { fontSize: 12, color: colors.accent, fontWeight: "600" },
  input: {
    minHeight: 56,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
    textAlignVertical: "top",
  },
  hintBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  hintText: { fontSize: 12, color: colors.faint },
})
