import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  FlatList,
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
import { Icon } from "@/components/Icon"
import { OpencodeClient, type FsEntry, type SessionInfo } from "@/opencode/client"
import { selectionRange, type ReviewComment } from "@/opencode/review"
import { isProbablyBinary } from "@/opencode/fileKind"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { useReviewDrafts } from "@/stores/reviewDrafts"
import { ensureConnection } from "@/transport/runtimes"
import { useT } from "@/i18n"
import { radius, spacing, useTheme, useThemedStyles, type Palette } from "@/theme"

type OpenFile = {
  path: string
  lines: string[]
  binary: boolean
  kind?: string
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
  const [error, setError] = useState<string | null>(null)
  const stageComments = useReviewDrafts((state) => state.add)
  const rootGesture = useRef({ x: 0, scrolled: false })
  const directoryCache = useRef(new Map<string, FsEntry[]>())
  const initialLoaded = useRef(false)

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
    async (path: string, options: { force?: boolean } = {}) => {
      if (!directory) return
      setError(null)
      setCurrentPath(path)
      setFile(null)
      setAnchor(null)
      setRange(null)
      if (!options.force) {
        const cached = directoryCache.current.get(path)
        if (cached) {
          setEntries(cached)
          setLoading(false)
          return
        }
      }
      setEntries(null)
      setLoading(true)
      try {
        const runtime = await ensureConnection(hostId)
        const list = sortEntries(await new OpencodeClient(runtime).listFiles(directory, path || undefined))
        directoryCache.current.set(path, list)
        setEntries(list)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "读取目录失败")
      } finally {
        setLoading(false)
      }
    },
    [directory, hostId],
  )

  useEffect(() => {
    directoryCache.current.clear()
  }, [directory])

  useEffect(() => {
    if (initialLoaded.current || connection?.status !== "ready" || !directory) return
    initialLoaded.current = true
    void loadDirectory("")
  }, [connection?.status, directory, loadDirectory])

  const openFile = async (entry: FsEntry) => {
    if (!directory) return
    setError(null)
    setAnchor(null)
    setRange(null)
    if (entry.previewable === false) {
      setFile({ path: entry.path, lines: [], binary: true, ...(entry.kind ? { kind: entry.kind } : {}) })
      return
    }
    setLoading(true)
    try {
      const runtime = await ensureConnection(hostId)
      const result = await new OpencodeClient(runtime).readFile(directory, entry.path)
      const kind = result.kind ?? entry.kind
      const binary =
        result.previewable === false
          ? true
          : kind !== undefined
            ? kind !== "text" && kind !== "unknown"
            : isProbablyBinary(result.content, result.contentType, entry.path)
      setFile({
        path: entry.path,
        lines: result.content.split("\n"),
        binary,
        ...(kind ? { kind } : {}),
      })
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

  // Stage the comments above the session composer instead of prompting the
  // host. The user can still edit the message, remove cards, and only then send.
  const send = () => {
    if (comments.length === 0 || readOnly) return
    stageComments(sessionId, directory, comments)
    router.back()
  }

  const parentPath = currentPath.replace(/\/+$/u, "").split("/").slice(0, -1).join("/")
  const relativePath = currentPath.replace(/\/+$/u, "").replace(/^\/+/u, "")
  const directoryLabel = relativePath ? `/${relativePath}` : "/"

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
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
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
          onPress={send}
          disabled={comments.length === 0 || readOnly}
          style={styles.send}
        >
          <Text style={[styles.sendText, (comments.length === 0 || readOnly) && styles.sendDisabled]}>{t("send")}</Text>
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
      </View>

      {error ? (
        <View style={styles.errorRow}>
          <Text style={styles.error}>{error}</Text>
          {entries === null ? <Button label={t("retry")} variant="outline" onPress={() => void loadDirectory(currentPath)} /> : null}
        </View>
      ) : null}

      {file ? (
        <FileView file={file} range={range} anchor={anchor} onSelectLine={selectLine} onBack={() => setFile(null)} />
      ) : (
        <View style={{ flex: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={directoryLabel}
            accessibilityState={{ disabled: !currentPath }}
            disabled={!currentPath}
            onPress={() => void loadDirectory(parentPath)}
            style={({ pressed }) => [
              styles.entry,
              !currentPath && styles.entryDisabled,
              pressed && currentPath && styles.entryPressed,
            ]}
          >
            <FileTypeIcon directory size={23} name={currentPath} />
            <Text style={[styles.entryName, !currentPath && styles.entryNameDisabled]} numberOfLines={1}>
              {directoryLabel}
            </Text>
            <Text style={styles.entryType}>{currentPath ? t("parentDir") : t("projectRoot")}</Text>
          </Pressable>
          <FlatList
            data={entries ?? []}
            keyExtractor={(entry) => entry.path}
            renderItem={({ item: entry }) => (
              <Pressable
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
            )}
            ListEmptyComponent={
              <Text style={styles.loading}>{loading || entries === null ? t("loading") : t("directoryEmpty")}</Text>
            }
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          />
        </View>
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
  onBack: () => void
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
        <Pressable accessibilityRole="button" onPress={props.onBack} hitSlop={8}>
          <Icon name="back" size={20} color={colors.text} />
        </Pressable>
        <FileTypeIcon name={props.file.path} size={18} />
        <Text style={styles.filePath} numberOfLines={1}>
          {basename(props.file.path)}
        </Text>
        {!props.file.binary ? (
          <View style={styles.wrapGroup}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("noWrap")}
              accessibilityState={{ selected: !wrap }}
              onPress={() => setWrap(false)}
              style={[styles.wrapIcon, !wrap && styles.wrapIconOn]}
            >
              <Icon name="noWrapText" size={17} color={!wrap ? colors.accent : colors.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("textWrap")}
              accessibilityState={{ selected: wrap }}
              onPress={() => setWrap(true)}
              style={[styles.wrapIcon, wrap && styles.wrapIconOn]}
            >
              <Icon name="wrapText" size={17} color={wrap ? colors.accent : colors.muted} />
            </Pressable>
          </View>
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
  filePath: { flex: 1, fontSize: 13, fontWeight: "500", color: colors.text, ...mono },
  wrapGroup: { flexDirection: "row", alignItems: "center", gap: 4 },
  wrapIcon: { width: 30, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  wrapIconOn: { backgroundColor: colors.accentSoft },
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
