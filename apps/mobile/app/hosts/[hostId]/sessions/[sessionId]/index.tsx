import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Animated,
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
import { BottomSheet } from "@/components/BottomSheet"
import { Icon } from "@/components/Icon"
import { MessageView } from "@/components/Message"
import { PendingDock } from "@/components/PendingDock"
import { SessionDrawer } from "@/components/SessionDrawer"
import { Badge, IconButton, Segmented } from "@/components/ui"
import { useT } from "@/i18n"
import {
  OpencodeClient,
  sessionBusy,
  toMillis,
  type AgentInfo,
  type FormInfo,
  type McpServer,
  type ModelInfo,
  type PermissionRequest,
  type SessionInfo,
  type SessionMessage,
} from "@/opencode/client"
import type { FormAnswers } from "@/opencode/forms"
import { ensureConnection, subscribeHostEvents } from "@/transport/runtimes"
import { useVoiceInput } from "@/features/voice/useVoiceInput"
import {
  loadSessionVoiceEngine,
  saveSessionVoiceEngine,
  usePreferences,
  type VoiceEnginePreference,
} from "@/stores/preferences"
import { useForeground } from "@/lib/useForeground"
import { useTheme, useThemedStyles, type Palette } from "@/theme"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"

type SheetMode = "main" | "agent" | "model"

export default function ChatScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string; sessionId: string }>()
  const hostId = params.hostId
  const sessionId = params.sessionId
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(chatStyles)

  const [session, setSession] = useState<SessionInfo | null>(null)
  const [messages, setMessages] = useState<SessionMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState("")
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<FormInfo[]>([])
  const [dockBusy, setDockBusy] = useState(false)
  const [olderCursor, setOlderCursor] = useState<string | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetMode, setSheetMode] = useState<SheetMode>("main")
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [mcp, setMcp] = useState<McpServer[] | null>(null)
  const [optionError, setOptionError] = useState<string | null>(null)
  const [optionsBusy, setOptionsBusy] = useState(false)
  const [voiceOverride, setVoiceOverride] = useState<VoiceEnginePreference | undefined>(undefined)
  const [modelQuery, setModelQuery] = useState("")
  const [insertNotice, setInsertNotice] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [turnNotice, setTurnNotice] = useState(false)
  const hostName = useHosts((state) => state.hosts.find((item) => item.id === hostId)?.name)
  const notificationsEnabled = usePreferences((state) => state.notifications)

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scrollRef = useRef<ScrollView>(null)
  const loadedRef = useRef(false)
  const atBottomRef = useRef(true)
  const initialScrollRef = useRef(false)
  const pendingOlder = useRef<{ height: number; y: number } | null>(null)
  const contentHeightRef = useRef(0)
  const scrollYRef = useRef(0)

  useEffect(() => {
    loadedRef.current = false
    initialScrollRef.current = false
    atBottomRef.current = true
    setMessages(null)
    setSession(null)
    setOlderCursor(undefined)
    setError(null)
    setPermissions([])
    setForms([])
    setVoiceOverride(undefined)
    setAgents(null)
    setModels(null)
    setMcp(null)
    setSheetOpen(false)
    void loadSessionVoiceEngine(sessionId).then(setVoiceOverride).catch(() => undefined)
  }, [sessionId])

  useEffect(() => {
    void ensureConnection(hostId).catch(() => undefined)
  }, [hostId])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  const connectionRole = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const hostAsrInfo = connectionRole?.session?.asr?.host
  const hostTranscribe =
    hostAsrInfo?.available === true
      ? async (wav: Uint8Array, durationMs: number): Promise<string> => {
          const runtime = await ensureConnection(hostId)
          const result = await runtime.transcribe({ audio: wav, mime: "audio/wav", durationMs, language: "zh" })
          return result.text
        }
      : undefined

  const dictation = useVoiceInput(
    (text) => {
      setDraft((current) => (current ? `${current.replace(/\s+$/u, "")} ${text}` : text))
      setInsertNotice(true)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      noticeTimer.current = setTimeout(() => setInsertNotice(false), 3_000)
    },
    { ...(hostTranscribe ? { hostTranscribe } : {}), ...(voiceOverride ? { preference: voiceOverride } : {}) },
  )

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
          client.listPermissions(sessionId).catch(() => []),
          client.listForms(sessionId).catch(() => []),
        ])
        setSession(detail)
        setPermissions(pendingPermissions)
        setForms(pendingForms)
        const latest = [...page.data].reverse()
        setMessages((current) =>
          mergeMessages(
            latest,
            (current ?? []).filter((message) => !message.id.startsWith("local_")),
          ),
        )
        const nextCursor = page.data.length >= 50 ? page.cursor?.next : undefined
        setOlderCursor((current) => (options.silent ? (current ?? nextCursor) : nextCursor))
        if (!options.silent) loadedRef.current = true
      } catch (cause) {
        if (!options.silent) setError(cause instanceof Error ? cause.message : t("error"))
      }
    },
    [hostId, sessionId, t],
  )

  useEffect(() => {
    if (!hostId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeHostEvents(hostId, (event) => {
      if (!event.type || !/^(session|message|permission|form)\./u.test(event.type)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load({ silent: true }), 450)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [hostId, load, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  useForeground(
    useCallback(() => {
      void ensureConnection(hostId, { force: true })
        .then(() => load({ silent: true }))
        .catch(() => undefined)
    }, [hostId, load]),
  )

  const loadOlder = async () => {
    if (!olderCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const runtime = await ensureConnection(hostId)
      const page = await new OpencodeClient(runtime).listMessages(sessionId, { limit: 50, cursor: olderCursor })
      pendingOlder.current = { height: contentHeightRef.current, y: scrollYRef.current }
      const older = [...page.data].reverse()
      setMessages((current) => mergeMessages(older, current ?? []))
      setOlderCursor(page.data.length >= 50 ? page.cursor?.next : undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setLoadingOlder(false)
    }
  }

  const replyPermission = async (request: PermissionRequest, decision: "once" | "always" | "reject") => {
    setDockBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).replyPermission(sessionId, request.id, decision)
      setPermissions((current) => current.filter((item) => item.id !== request.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setDockBusy(false)
    }
  }

  const submitForm = async (form: FormInfo, answer: FormAnswers) => {
    setDockBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).replyForm(sessionId, form.id, answer)
      setForms((current) => current.filter((item) => item.id !== form.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setDockBusy(false)
    }
  }

  const cancelForm = async (form: FormInfo) => {
    setDockBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).cancelForm(sessionId, form.id)
      setForms((current) => current.filter((item) => item.id !== form.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setDockBusy(false)
    }
  }

  const openSettings = async () => {
    setSheetMode("main")
    setSheetOpen(true)
    if (agents && models && mcp) return
    setOptionsBusy(true)
    setOptionError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const client = new OpencodeClient(runtime)
      const directory = session?.location?.directory
      const [agentList, modelList, mcpList] = await Promise.all([
        client.listAgents(directory),
        client.listModels(directory),
        client.listMcp(directory).catch(() => []),
      ])
      setAgents(agentList)
      setModels(modelList)
      setMcp(mcpList)
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const selectAgent = async (agentId: string) => {
    setOptionsBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).switchAgent(sessionId, agentId)
      setSession((current) => (current ? { ...current, agent: agentId } : current))
      setSheetMode("main")
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const selectModel = async (model: ModelInfo) => {
    setOptionsBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).switchModel(sessionId, {
        id: model.modelID,
        providerID: model.providerID,
      })
      setSession((current) =>
        current ? { ...current, model: { id: model.modelID, providerID: model.providerID } } : current,
      )
      setSheetMode("main")
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const toggleMcp = async (server: McpServer) => {
    const connected = server.status?.status === "connected"
    setOptionsBusy(true)
    setOptionError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const client = new OpencodeClient(runtime)
      await client.setMcpConnected(server.name, !connected, session?.location?.directory)
      setMcp(await client.listMcp(session?.location?.directory).catch(() => mcp ?? []))
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const chooseVoice = async (value: VoiceEnginePreference) => {
    setVoiceOverride(value)
    await saveSessionVoiceEngine(sessionId, value).catch(() => undefined)
  }

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
    atBottomRef.current = true
    setMessages((current) => [...(current ?? []), optimistic])
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).prompt(sessionId, text)
      await load({ silent: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
      setDraft(text)
      setMessages((current) => (current ?? []).filter((message) => message.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).interrupt(sessionId)
      await load({ silent: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    }
  }

  const runningNow = sending || (session ? sessionBusy(session) : false)
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !runningNow && notificationsEnabled) {
      setTurnNotice(true)
      const timer = setTimeout(() => setTurnNotice(false), 4_000)
      wasRunning.current = runningNow
      return () => clearTimeout(timer)
    }
    wasRunning.current = runningNow
  }, [runningNow, notificationsEnabled])

  const ready = connectionRole?.status === "ready"
  const readOnly = connectionRole?.session?.device?.scope === "read"
  const running = runningNow
  const title = session?.title?.trim() || t("sessions")
  const agentName = session?.agent ?? t("defaultAgent")
  const modelInfo = models?.find(
    (model) => model.modelID === session?.model?.id && model.providerID === session?.model?.providerID,
  )
  const modelName = modelInfo?.name ?? session?.model?.id ?? t("defaultModel")
  const filteredModels = (models ?? []).filter((model) => {
    const query = modelQuery.trim().toLowerCase()
    if (!query) return true
    return (
      model.name.toLowerCase().includes(query) ||
      model.modelID.toLowerCase().includes(query) ||
      model.providerID.toLowerCase().includes(query)
    )
  })

  const onContentSizeChange = (_width: number, height: number) => {
    contentHeightRef.current = height
    if (pendingOlder.current) {
      const delta = height - pendingOlder.current.height
      if (delta > 0) scrollRef.current?.scrollTo({ y: pendingOlder.current.y + delta, animated: false })
      pendingOlder.current = null
      return
    }
    if (atBottomRef.current || !initialScrollRef.current) {
      initialScrollRef.current = true
      scrollRef.current?.scrollToEnd({ animated: false })
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <IconButton label={t("sessions")} onPress={() => setDrawerOpen(true)}>
          <Icon name="menu" size={22} color={colors.text} />
        </IconButton>
        <View style={styles.headerCenter}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.headerMeta}>
            {running ? <RunningDot /> : <View style={[styles.dot, { backgroundColor: ready ? colors.success : colors.faint }]} />}
            <Text style={styles.subtitle} numberOfLines={1}>
              {running ? t("running") : ready ? t("encrypted") : t("offline")}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <IconButton
            label={t("review")}
            onPress={() =>
              router.push({
                pathname: "/hosts/[hostId]/sessions/[sessionId]/review",
                params: { hostId, sessionId, directory: session?.location?.directory ?? "" },
              })
            }
          >
            <Icon name="eye" size={20} color={colors.muted} />
          </IconButton>
          <IconButton
            label={t("diff")}
            onPress={() =>
              router.push({
                pathname: "/hosts/[hostId]/sessions/[sessionId]/diff",
                params: { hostId, sessionId },
              })
            }
          >
            <Icon name="diff" size={20} color={colors.muted} />
          </IconButton>
        </View>
      </View>

      <View style={{ flex: 1 }}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.messages}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={onContentSizeChange}
          onScroll={(event) => {
            const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent
            const near = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 90
            atBottomRef.current = near
            scrollYRef.current = contentOffset.y
            setShowJump(!near)
          }}
          scrollEventThrottle={80}
        >
          {!ready ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{t("hostOffline")}</Text>
              <Text style={styles.noticeBody}>{t("hostOfflineBody")}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void ensureConnection(hostId, { force: true }).catch(() => undefined)}
                style={{ marginTop: 10, alignSelf: "flex-start" }}
              >
                <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>{t("retry")}</Text>
              </Pressable>
            </View>
          ) : null}

          {turnNotice ? (
          <View style={[styles.turnNotice, { backgroundColor: colors.accentSoft }]}>
            <Icon name="check" size={13} color={colors.accent} />
            <Text style={{ fontSize: 12, color: colors.accent, fontWeight: "600" }}>{t("turnCompleteNotice")}</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

          {olderCursor && messages && messages.length > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => void loadOlder()} style={styles.olderButton}>
              <Text style={styles.olderText}>{loadingOlder ? t("loadingOlder") : t("loadOlder")}</Text>
            </Pressable>
          ) : null}

          {messages === null ? (
            <View style={{ paddingTop: 60, alignItems: "center" }}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : null}
          {messages?.length === 0 ? (
            <Text style={styles.emptyMessages}>{t("noMessages")}</Text>
          ) : null}

          {messages?.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}

          {running ? (
            <View style={styles.runningRow}>
              <RunningDot />
              <Text style={styles.runningText}>{t("running")}</Text>
              <Pressable accessibilityRole="button" onPress={() => void stop()} style={styles.stopChip}>
                <Icon name="stop" size={11} color={colors.danger} />
                <Text style={{ fontSize: 11.5, fontWeight: "600", color: colors.danger }}>{t("stop")}</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        {showJump && messages && messages.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              atBottomRef.current = true
              setShowJump(false)
              scrollRef.current?.scrollToEnd({ animated: true })
            }}
            style={[styles.jump, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Icon name="chevronDown" size={16} color={colors.muted} />
            <Text style={{ fontSize: 12, color: colors.muted, fontWeight: "500" }}>{t("scrollToBottom")}</Text>
          </Pressable>
        ) : null}
      </View>

      <PendingDock
        permissions={permissions}
        forms={forms}
        busy={dockBusy || readOnly}
        onReplyPermission={(request, decision) => void replyPermission(request, decision)}
        onSubmitForm={(form, answer) => void submitForm(form, answer)}
        onCancelForm={(form) => void cancelForm(form)}
      />

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {dictation.listening ? (
          <Pressable accessibilityRole="button" onPress={dictation.stop} style={styles.voiceBar}>
            <Text style={styles.voiceText}>
              {dictation.engine === "local"
                ? t("listeningLocal")
                : dictation.engine === "host"
                  ? t("listeningHost")
                  : t("listeningSystem")}
            </Text>
            <Text style={styles.voiceStop}>{t("stop")}</Text>
          </Pressable>
        ) : null}
        {dictation.transcribing ? (
          <View style={styles.voiceBar}>
            <Text style={styles.voiceText}>
              {dictation.engine === "host" ? t("transcribingHost") : t("transcribingLocal")}
            </Text>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : null}
        {dictation.error ? (
          <Pressable accessibilityRole="button" onPress={dictation.clearError} style={styles.voiceBar}>
            <Text style={styles.voiceError}>{dictation.error}</Text>
            <Text style={styles.voiceStop}>{t("close")}</Text>
          </Pressable>
        ) : null}
        {insertNotice ? <Text style={styles.insertNotice}>{t("inserted")}</Text> : null}

        <View style={styles.composerRow}>
          <IconButton
            label={t("dictation")}
            active={dictation.listening}
            disabled={!ready || sending || readOnly || dictation.transcribing}
            onPress={() => (dictation.listening ? dictation.stop() : void dictation.start("zh-CN"))}
          >
            <Icon name="mic" size={20} color={dictation.listening ? colors.accent : colors.muted} />
          </IconButton>
          <TextInput
            editable={ready && !sending && !readOnly}
            multiline
            onChangeText={setDraft}
            placeholder={readOnly ? t("readOnlyDevice") : ready ? t("messagePlaceholder") : t("waitingHost")}
            placeholderTextColor={colors.faint}
            style={styles.input}
            value={draft}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("send")}
            disabled={!ready || sending || readOnly || draft.trim().length === 0}
            onPress={() => void send()}
            style={({ pressed }) => [
              styles.send,
              (!ready || sending || readOnly || draft.trim().length === 0) && { opacity: 0.35 },
              pressed && { opacity: 0.7 },
            ]}
          >
            {sending ? (
              <ActivityIndicator color={colors.accentText} size="small" />
            ) : (
              <Icon name="send" size={18} color={colors.accentText} />
            )}
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => void openSettings()}
          style={({ pressed }) => [styles.settingsBar, pressed && { opacity: 0.7 }]}
        >
          <Icon name="sliders" size={15} color={colors.muted} />
          <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.muted }}>{t("sessionSettings")}</Text>
          <Text style={styles.settingsMeta} numberOfLines={1}>
            {agentName} · {modelName}
          </Text>
          <Icon name="chevronRight" size={14} color={colors.faint} />
        </Pressable>
      </View>

      <SessionDrawer
        visible={drawerOpen}
        hostId={hostId}
        hostName={hostName ?? t("sessions")}
        currentSessionId={sessionId}
        onClose={() => setDrawerOpen(false)}
        onSelect={(next) =>
          router.replace({ pathname: "/hosts/[hostId]/sessions/[sessionId]", params: { hostId, sessionId: next.id } })
        }
        onNewSession={() =>
          router.push({ pathname: "/hosts/[hostId]/sessions", params: { hostId, new: "1" } })
        }
        onHosts={() => router.replace("/")}
      />

      <BottomSheet
        visible={sheetOpen}
        title={
          sheetMode === "agent" ? t("agent") : sheetMode === "model" ? t("model") : t("sessionSettings")
        }
        onClose={() => setSheetOpen(false)}
        maxHeight={640}
      >
        {sheetMode !== "main" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setSheetMode("main")
              setModelQuery("")
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6 }}
          >
            <Icon name="back" size={16} color={colors.muted} />
            <Text style={{ fontSize: 13, color: colors.muted }}>{t("back")}</Text>
          </Pressable>
        ) : null}

        {optionsBusy ? <ActivityIndicator style={{ marginVertical: 12 }} color={colors.accent} /> : null}
        {optionError ? <Text style={{ fontSize: 12.5, color: colors.danger, marginBottom: 8 }}>{optionError}</Text> : null}

        {sheetMode === "main" ? (
          <View style={{ gap: 4 }}>
            <SheetRow
              icon="spark"
              label={t("agent")}
              value={agentName}
              onPress={() => setSheetMode("agent")}
            />
            <SheetRow icon="message" label={t("model")} value={modelName} onPress={() => setSheetMode("model")} />

            <Text style={styles.sheetLabel}>{t("engine")}</Text>
            <Segmented
              value={voiceOverride ?? "auto"}
              options={[
                { value: "auto", label: t("engineAuto") },
                { value: "local", label: t("engineLocal") },
                { value: "host", label: t("engineHost") },
              ]}
              onChange={(value) => void chooseVoice(value)}
            />
            <Text style={{ fontSize: 11.5, color: colors.faint, marginTop: 4 }}>{t("engineAutoHint")}</Text>

            <Text style={styles.sheetLabel}>{t("mcp")}</Text>
            <Text style={{ fontSize: 11.5, color: colors.faint, marginBottom: 4 }}>{t("mcpHint")}</Text>
            {mcp === null ? (
              <Text style={{ fontSize: 12.5, color: colors.faint }}>{t("loading")}</Text>
            ) : mcp.length === 0 ? (
              <Text style={{ fontSize: 12.5, color: colors.faint }}>{t("noMcp")}</Text>
            ) : (
              mcp.map((server) => {
                const status = server.status?.status ?? "unknown"
                const connected = status === "connected"
                return (
                  <Pressable
                    key={server.name}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: connected }}
                    disabled={optionsBusy}
                    onPress={() => void toggleMcp(server)}
                    style={({ pressed }) => [
                      {
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 10,
                        paddingVertical: 12,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.border,
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>
                        {server.title?.trim() || server.name}
                      </Text>
                      <Text style={{ fontSize: 11.5, color: colors.faint, marginTop: 2 }}>{status}</Text>
                    </View>
                    <Badge text={connected ? t("on") : t("off")} tone={connected ? "success" : "neutral"} />
                    <View
                      style={{
                        width: 40,
                        height: 24,
                        borderRadius: 12,
                        padding: 3,
                        backgroundColor: connected ? colors.accent : colors.surface2,
                        alignItems: connected ? "flex-end" : "flex-start",
                      }}
                    >
                      <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "#FFFFFF" }} />
                    </View>
                  </Pressable>
                )
              })
            )}

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setSheetOpen(false)
                router.push({
                  pathname: "/hosts/[hostId]/sessions/[sessionId]/review",
                  params: { hostId, sessionId, directory: session?.location?.directory ?? "" },
                })
              }}
              style={({ pressed }) => [styles.sheetAction, pressed && { opacity: 0.7 }]}
            >
              <Icon name="eye" size={18} color={colors.muted} />
              <Text style={styles.sheetActionText}>{t("review")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setSheetOpen(false)
                router.push({ pathname: "/hosts/[hostId]/sessions/[sessionId]/diff", params: { hostId, sessionId } })
              }}
              style={({ pressed }) => [styles.sheetAction, pressed && { opacity: 0.7 }]}
            >
              <Icon name="diff" size={18} color={colors.muted} />
              <Text style={styles.sheetActionText}>{t("diff")}</Text>
            </Pressable>
          </View>
        ) : null}

        {sheetMode === "agent" ? (
          <View>
            {(agents ?? []).filter((agent) => agent.mode !== "subagent").map((agent) => (
              <Pressable
                key={agent.id}
                accessibilityRole="button"
                accessibilityState={{ selected: agent.id === session?.agent }}
                onPress={() => void selectAgent(agent.id)}
                style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14.5, fontWeight: "500", color: colors.text }}>{agent.name}</Text>
                  {agent.description ? (
                    <Text style={{ fontSize: 12, color: colors.faint, marginTop: 2 }} numberOfLines={2}>
                      {agent.description}
                    </Text>
                  ) : null}
                </View>
                {agent.id === session?.agent ? <Icon name="check" size={18} color={colors.accent} /> : null}
              </Pressable>
            ))}
          </View>
        ) : null}

        {sheetMode === "model" ? (
          <View>
            <TextInput
              value={modelQuery}
              onChangeText={setModelQuery}
              placeholder={t("search")}
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              style={styles.modelSearch}
            />
            {filteredModels.map((model) => {
              const selected =
                model.modelID === session?.model?.id && model.providerID === session?.model?.providerID
              return (
                <Pressable
                  key={`${model.providerID}/${model.modelID}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => void selectModel(model)}
                  style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: "500", color: colors.text }} numberOfLines={1}>
                      {model.name}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: colors.faint, marginTop: 2 }} numberOfLines={1}>
                      {model.providerID} / {model.modelID}
                    </Text>
                  </View>
                  {selected ? <Icon name="check" size={18} color={colors.accent} /> : null}
                </Pressable>
              )
            })}
          </View>
        ) : null}
      </BottomSheet>
    </KeyboardAvoidingView>
  )
}

function SheetRow(props: {
  icon: "spark" | "message"
  label: string
  value: string
  onPress: () => void
}) {
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Icon name={props.icon} size={18} color={colors.muted} />
      <Text style={{ fontSize: 14.5, fontWeight: "500", color: colors.text }}>{props.label}</Text>
      <Text style={{ flex: 1, textAlign: "right", fontSize: 13, color: colors.muted }} numberOfLines={1}>
        {props.value}
      </Text>
      <Icon name="chevronRight" size={15} color={colors.faint} />
    </Pressable>
  )
}

function RunningDot() {
  const { colors } = useTheme()
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [opacity])
  return <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent, opacity }} />
}

function mergeMessages(first: SessionMessage[], second: SessionMessage[]): SessionMessage[] {
  const byId = new Map<string, SessionMessage>()
  for (const message of [...first, ...second]) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => toMillis(left.time?.created) - toMillis(right.time?.created))
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const chatStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 8,
      paddingBottom: 8,
      gap: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerCenter: { flex: 1, alignItems: "center" },
    headerMeta: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
    headerActions: { flexDirection: "row", alignItems: "center" },
    title: { fontSize: 15.5, fontWeight: "600", color: colors.text },
    subtitle: { fontSize: 11, color: colors.muted },
    dot: { width: 6, height: 6, borderRadius: 3 },
    messages: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28, gap: 14 },
    emptyMessages: { fontSize: 14, color: colors.faint, textAlign: "center", marginTop: 60 },
    error: { fontSize: 13, lineHeight: 19, color: colors.danger },
    olderButton: { alignSelf: "center", paddingVertical: 6, paddingHorizontal: 12 },
    olderText: { fontSize: 12.5, color: colors.accent, fontWeight: "500" },
    notice: {
      padding: 16,
      borderRadius: 14,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    noticeTitle: { fontSize: 14.5, fontWeight: "600", color: colors.text },
    noticeBody: { marginTop: 4, fontSize: 12.5, lineHeight: 18, color: colors.muted },
    runningRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
    runningText: { flex: 1, fontSize: 12.5, color: colors.muted },
    stopChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: colors.dangerSoft,
    },
    jump: {
      position: "absolute",
      right: 18,
      bottom: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
    },
    composer: {
      paddingHorizontal: 12,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      backgroundColor: colors.bg,
      gap: 6,
    },
    composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 4 },
    input: {
      flex: 1,
      maxHeight: 132,
      minHeight: 42,
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 10,
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      fontSize: 15,
      lineHeight: 21,
      color: colors.text,
      textAlignVertical: "top",
    },
    send: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    settingsBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 8,
    },
    settingsMeta: { flex: 1, textAlign: "right", fontSize: 11.5, color: colors.faint },
    voiceBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 10,
      backgroundColor: colors.surface,
    },
    voiceText: { fontSize: 12.5, color: colors.accent, fontWeight: "500" },
    voiceError: { flex: 1, fontSize: 12, color: colors.danger },
    voiceStop: { fontSize: 12.5, color: colors.muted },
    insertNotice: { fontSize: 11.5, color: colors.success, paddingHorizontal: 8 },
    turnNotice: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 7,
      borderRadius: 10,
    },
    sheetLabel: { fontSize: 12, fontWeight: "600", color: colors.faint, marginTop: 18, marginBottom: 6 },
    sheetAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    sheetActionText: { fontSize: 14.5, fontWeight: "500", color: colors.text },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    modelSearch: {
      height: 40,
      borderRadius: 10,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      fontSize: 13.5,
      color: colors.text,
      marginTop: 6,
      marginBottom: 4,
    },
  })
