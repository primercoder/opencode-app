import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { PendingDock } from "@/components/PendingDock"
import { SessionControls } from "@/components/SessionControls"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import {
  OpencodeClient,
  toMillis,
  type AgentInfo,
  type AssistantContent,
  type FormInfo,
  type ModelInfo,
  type PermissionRequest,
  type SessionInfo,
  type SessionMessage,
} from "@/opencode/client"
import type { FormAnswers } from "@/opencode/forms"
import { ensureConnection, subscribeHostEvents } from "@/transport/runtimes"
import { useDictation } from "@/features/voice/useDictation"
import { useForeground } from "@/lib/useForeground"
import { colors, radius, spacing } from "@/theme"

export default function ChatScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string; sessionId: string }>()
  const { hostId, sessionId } = params
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [messages, setMessages] = useState<SessionMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraft] = useState("")
  const [insertNotice, setInsertNotice] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<FormInfo[]>([])
  const [dockBusy, setDockBusy] = useState(false)
  const [olderCursor, setOlderCursor] = useState<string | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const loadedRef = useRef(false)
  const atBottomRef = useRef(true)

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  const dictation = useDictation((text) => {
    setDraft((current) => {
      if (!current) return text
      return /[\s\n]$/u.test(current) ? `${current}${text}` : `${current} ${text}`
    })
    setInsertNotice(true)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setInsertNotice(false), 3_000)
  })

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!hostId || !sessionId) return
      if (!options.silent) setError(null)
      try {
        const runtime = await ensureConnection(hostId)
        const client = new OpencodeClient(runtime)
        const [detail, page, pendingPermissions, pendingForms] = await Promise.all([
          client.getSession(sessionId),
          client.listMessages(sessionId, { limit: 50, order: "desc" }),
          client.listPermissions(sessionId),
          client.listForms(sessionId),
        ])
        setSession(detail)
        setPermissions(pendingPermissions)
        setForms(pendingForms)
        const latest = [...page.data].reverse()
        setMessages((current) => mergeMessages(latest, (current ?? []).filter((message) => !message.id.startsWith("local_"))))
        if (!options.silent) setOlderCursor(page.cursor)
        else setOlderCursor((current) => current ?? page.cursor)
        if (!options.silent) loadedRef.current = true
        if (!options.silent || atBottomRef.current) {
          requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }))
        }
      } catch (cause) {
        if (!options.silent) setError(cause instanceof Error ? cause.message : "加载会话失败")
      }
    },
    [hostId, sessionId],
  )

  useEffect(() => {
    if (connection?.status !== "ready" || loadedRef.current) return
    void load()
  }, [connection?.status, load])

  useEffect(() => {
    if (connection?.status !== "ready") return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeHostEvents(hostId, (event) => {
      if (!isSessionEvent(event.type)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load({ silent: true }), 400)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [connection?.status, hostId, load])

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    void ensureConnection(hostId)
      .then((runtime) => {
        if (!active) return
        unsubscribe = runtime.onStateChange((state) => {
          if (state === "ready") void load({ silent: true })
        })
      })
      .catch(() => undefined)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [hostId, load])

  const loadOlder = async () => {
    if (!olderCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const runtime = await ensureConnection(hostId)
      const page = await new OpencodeClient(runtime).listMessages(sessionId, {
        limit: 50,
        order: "desc",
        cursor: olderCursor,
      })
      const older = [...page.data].reverse()
      setMessages((current) => mergeMessages(older, current ?? []))
      setOlderCursor(page.cursor)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载更早消息失败")
    } finally {
      setLoadingOlder(false)
    }
  }

  const replyPermission = async (request: PermissionRequest, decision: "once" | "always" | "reject") => {
    setDockBusy(true)
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).replyPermission(sessionId, request.id, decision)
      setPermissions((current) => current.filter((item) => item.id !== request.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回复权限失败")
    } finally {
      setDockBusy(false)
    }
  }

  const submitForm = async (form: FormInfo, answer: FormAnswers) => {
    setDockBusy(true)
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).replyForm(sessionId, form.id, answer)
      setForms((current) => current.filter((item) => item.id !== form.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交表单失败")
    } finally {
      setDockBusy(false)
    }
  }

  const cancelForm = async (form: FormInfo) => {
    setDockBusy(true)
    setError(null)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).cancelForm(sessionId, form.id)
      setForms((current) => current.filter((item) => item.id !== form.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消表单失败")
    } finally {
      setDockBusy(false)
    }
  }

  const loadAgents = async (): Promise<AgentInfo[]> => {
    const runtime = await ensureConnection(hostId)
    return new OpencodeClient(runtime).listAgents(session?.location?.directory)
  }

  const loadModels = async (): Promise<ModelInfo[]> => {
    const runtime = await ensureConnection(hostId)
    return new OpencodeClient(runtime).listModels(session?.location?.directory)
  }

  const selectAgent = async (agent: string) => {
    const runtime = await ensureConnection(hostId)
    await new OpencodeClient(runtime).switchAgent(sessionId, agent)
    setSession((current) => (current ? { ...current, agent } : current))
  }

  const selectModel = async (model: { id: string; providerID: string; variant?: string }) => {
    const runtime = await ensureConnection(hostId)
    await new OpencodeClient(runtime).switchModel(sessionId, model)
    setSession((current) => (current ? { ...current, model } : current))
  }

  useForeground(
    useCallback(() => {
      void ensureConnection(hostId, { force: true })
        .then(() => load({ silent: true }))
        .catch(() => undefined)
    }, [hostId, load]),
  )

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    setDraft("")
    const optimistic: SessionMessage = {
      id: `local_${Date.now()}`,
      type: "user",
      text,
      time: { created: Date.now() },
    }
    setMessages((current) => [...(current ?? []), optimistic])
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }))
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).prompt(sessionId, text)
      await load({ silent: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败")
      setDraft(text)
      setMessages((current) => (current ?? []).filter((message) => message.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const ready = connection?.status === "ready"
  const readOnly = connection?.session?.device?.scope === "read"
  const title = session?.title?.trim() || "会话"

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + spacing.md }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ 会话</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {host?.name ?? "主机"} · {ready ? "端到端加密" : "未连接"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: "/hosts/[hostId]/sessions/[sessionId]/review",
                params: { hostId, sessionId, directory: session?.location?.directory ?? "" },
              })
            }
            style={styles.headerAction}
          >
            <Text style={styles.backText}>审阅</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: "/hosts/[hostId]/sessions/[sessionId]/diff",
                params: { hostId, sessionId },
              })
            }
            style={styles.headerAction}
          >
            <Text style={styles.backText}>Diff</Text>
          </Pressable>
        </View>
      </View>

      <SessionControls
        session={session ?? { id: sessionId }}
        disabled={!ready || !session}
        loadAgents={loadAgents}
        loadModels={loadModels}
        onSelectAgent={selectAgent}
        onSelectModel={selectModel}
      />

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.text} />}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScroll={(event) => {
          const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent
          atBottomRef.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80
        }}
        scrollEventThrottle={100}
      >
        {!ready && connection?.status === "error" ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>主机离线</Text>
            <Text style={styles.noticeBody}>{connection.error?.message ?? "连接已断开"}</Text>
            <View style={styles.noticeAction}>
              <Button label="重试" onPress={() => void ensureConnection(hostId, { force: true }).catch(() => undefined)} />
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {olderCursor ? (
          <Pressable accessibilityRole="button" onPress={() => void loadOlder()} style={styles.olderButton}>
            <Text style={styles.olderText}>{loadingOlder ? "加载中…" : "加载更早消息"}</Text>
          </Pressable>
        ) : null}
        {messages === null ? <Text style={styles.loading}>正在加载消息…</Text> : null}
        {messages?.length === 0 ? <Text style={styles.loading}>还没有消息。发送第一条消息开始。</Text> : null}

        {messages?.map((message) => <MessageRow key={message.id} message={message} />)}
      </ScrollView>

      <PendingDock
        permissions={permissions}
        forms={forms}
        busy={dockBusy || readOnly}
        onReplyPermission={(request, decision) => void replyPermission(request, decision)}
        onSubmitForm={(form, answer) => void submitForm(form, answer)}
        onCancelForm={(form) => void cancelForm(form)}
      />

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {dictation.listening ? (
          <Pressable accessibilityRole="button" onPress={dictation.stop} style={styles.voiceBar}>
            <Text style={styles.voiceText}>正在听写…（系统语音识别）</Text>
            <Text style={styles.voiceStop}>停止</Text>
          </Pressable>
        ) : null}
        {dictation.error ? (
          <Pressable accessibilityRole="button" onPress={dictation.clearError} style={styles.voiceBar}>
            <Text style={styles.voiceError}>{dictation.error}</Text>
            <Text style={styles.voiceStop}>关闭</Text>
          </Pressable>
        ) : null}
        {insertNotice ? <Text style={styles.insertNotice}>已插入，请确认后发送</Text> : null}
        <View style={styles.composerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dictation.listening ? "停止听写" : "语音听写"}
            disabled={!ready || sending || readOnly}
            onPress={() => (dictation.listening ? dictation.stop() : void dictation.start("zh-CN"))}
            style={({ pressed }) => [
              styles.mic,
              dictation.listening && styles.micActive,
              (!ready || sending || readOnly) && styles.sendDisabled,
              pressed && styles.sendPressed,
            ]}
          >
            <Text style={[styles.micText, dictation.listening && styles.micTextActive]}>🎤</Text>
          </Pressable>
          <TextInput
            editable={ready && !sending && !readOnly}
            multiline
            onChangeText={setDraft}
            placeholder={readOnly ? "只读设备无法发送消息" : ready ? "输入消息…" : "等待主机连接…"}
            placeholderTextColor={colors.faint}
            style={styles.input}
            value={draft}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            disabled={!ready || sending || readOnly || draft.trim().length === 0}
            onPress={() => void send()}
            style={({ pressed }) => [
              styles.send,
              (!ready || sending || readOnly || draft.trim().length === 0) && styles.sendDisabled,
              pressed && styles.sendPressed,
            ]}
          >
            {sending ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={styles.sendText}>发送</Text>}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

function isSessionEvent(type: string | undefined): boolean {
  if (!type) return false
  return /^(message|session|permission|form)\./u.test(type)
}

function mergeMessages(first: SessionMessage[], second: SessionMessage[]): SessionMessage[] {
  const byId = new Map<string, SessionMessage>()
  for (const message of [...first, ...second]) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => toMillis(left.time?.created) - toMillis(right.time?.created))
}

function MessageRow(props: { message: SessionMessage }) {
  const { message } = props

  if (message.type === "user") {
    return (
      <View style={[styles.bubble, styles.userBubble]}>
        <Text style={styles.userText}>{message.text ?? ""}</Text>
      </View>
    )
  }

  if (message.type === "assistant") {
    const blocks = message.content ?? []
    return (
      <View style={styles.assistant}>
        {blocks.map((block, index) => (
          <ContentBlock key={index} block={block} />
        ))}
        {message.error?.message ? <Text style={styles.error}>{message.error.message}</Text> : null}
      </View>
    )
  }

  if (message.type === "idle") {
    return <Text style={styles.systemLine}>{message.outcome === "interrupted" ? "已中断" : "本轮结束"}</Text>
  }

  if (message.type === "system" || message.type === "synthetic" || message.type === "skill") {
    const text = message.text ?? message.description ?? message.name ?? message.type
    return <Text style={styles.systemLine}>{text}</Text>
  }

  if (message.type === "shell") {
    const text = (message as unknown as { command?: string }).command ?? "shell"
    return (
      <View style={styles.toolCard}>
        <Text style={styles.toolName}>shell</Text>
        <Text style={styles.toolText}>{text}</Text>
      </View>
    )
  }

  return null
}

function ContentBlock(props: { block: AssistantContent }) {
  const { block } = props

  if (block.type === "text") {
    return <Text style={styles.assistantText}>{(block as { text: string }).text}</Text>
  }

  if (block.type === "reasoning") {
    return (
      <View style={styles.reasoning}>
        <Text style={styles.reasoningText}>{(block as { text: string }).text}</Text>
      </View>
    )
  }

  if (block.type === "tool") {
    const tool = block as {
      name: string
      state?: { status?: string; input?: unknown; error?: { message?: string } }
    }
    const status = tool.state?.status ?? "running"
    return (
      <View style={styles.toolCard}>
        <View style={styles.toolHeader}>
          <Text style={styles.toolName}>{tool.name}</Text>
          <Text style={[styles.toolStatus, status === "error" && styles.toolStatusError]}>{statusLabel(status)}</Text>
        </View>
        {tool.state?.input !== undefined ? (
          <Text style={styles.toolText} numberOfLines={4}>
            {summarizeInput(tool.state.input)}
          </Text>
        ) : null}
        {tool.state?.error?.message ? <Text style={styles.error}>{tool.state.error.message}</Text> : null}
      </View>
    )
  }

  return null
}

function summarizeInput(input: unknown): string {
  if (typeof input === "string") return input
  try {
    const text = JSON.stringify(input)
    return text.length > 500 ? `${text.slice(0, 500)}…` : text
  } catch {
    return String(input)
  }
}

function statusLabel(status: string): string {
  if (status === "completed") return "完成"
  if (status === "error") return "失败"
  if (status === "streaming") return "生成中"
  return "运行中"
}

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
  headerActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: spacing.md, width: 88 },
  headerAction: { paddingVertical: 2 },
  backText: { fontSize: 15, color: colors.muted },
  headerCenter: { flex: 1, alignItems: "center" },
  title: { fontSize: 16, fontWeight: "600", color: colors.text },
  subtitle: { marginTop: 2, fontSize: 11, color: colors.muted },
  messages: { padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md },
  loading: { textAlign: "center", fontSize: 13, color: colors.faint, marginTop: spacing.lg },
  olderButton: { alignSelf: "center", paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  olderText: { fontSize: 13, color: colors.accent },
  error: { fontSize: 13, color: colors.danger, lineHeight: 19 },
  bubble: { maxWidth: "86%", paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, borderRadius: radius.lg },
  userBubble: { alignSelf: "flex-end", backgroundColor: colors.accent },
  userText: { color: "#FFFFFF", fontSize: 15, lineHeight: 21 },
  assistant: { alignSelf: "stretch", gap: spacing.sm },
  assistantText: { fontSize: 15, lineHeight: 23, color: colors.text },
  reasoning: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: spacing.md,
    paddingVertical: 2,
  },
  reasoningText: { fontSize: 13, lineHeight: 20, color: colors.muted, fontStyle: "italic" },
  systemLine: { textAlign: "center", fontSize: 12, color: colors.faint, marginVertical: spacing.xs },
  toolCard: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  toolHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toolName: { fontSize: 13, fontWeight: "600", color: colors.text },
  toolStatus: { fontSize: 11, color: colors.success },
  toolStatusError: { color: colors.danger },
  toolText: { fontSize: 12, lineHeight: 17, color: colors.muted, fontFamily: Platform.select({ android: "monospace", default: undefined }) },
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
  composer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
    gap: spacing.sm,
  },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  voiceBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  voiceText: { fontSize: 13, color: colors.accent, fontWeight: "500" },
  voiceError: { flex: 1, fontSize: 12, color: colors.danger },
  voiceStop: { fontSize: 13, color: colors.muted },
  insertNotice: { fontSize: 12, color: colors.success, paddingHorizontal: spacing.sm },
  mic: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  micActive: { backgroundColor: colors.danger, borderColor: colors.danger },
  micText: { fontSize: 18 },
  micTextActive: { color: "#FFFFFF" },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 15,
    lineHeight: 21,
    color: colors.text,
    textAlignVertical: "top",
  },
  send: {
    minWidth: 64,
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.35 },
  sendPressed: { opacity: 0.7 },
  sendText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
})
