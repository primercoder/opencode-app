import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
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
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition"
import { BottomSheet } from "@/components/BottomSheet"
import { Icon } from "@/components/Icon"
import { MessageView } from "@/components/Message"
import { PendingDock } from "@/components/PendingDock"
import { SessionDrawer } from "@/components/SessionDrawer"
import { Badge, Button, IconButton, Segmented } from "@/components/ui"
import { useT } from "@/i18n"
import {
  OpencodeClient,
  sessionBusy,
  toMillis,
  type AgentInfo,
  type FormInfo,
  type InboxItem,
  type McpServer,
  type ModelInfo,
  type PermissionRequest,
  type ProjectInfo,
  type SessionInfo,
  type SessionMessage,
  type SkillInfo,
} from "@/opencode/client"
import type { FormAnswers } from "@/opencode/forms"
import { contextUsage, formatTokens, runningActivities, type RunningActivity } from "@/features/session/activity"
import { invalidateSessionIndex } from "@/features/sessions/useSessionIndex"
import { listMobileModels } from "@/features/voice/models"
import { useVoiceInput } from "@/features/voice/useVoiceInput"
import { ensureConnection, subscribeHostEvents, closeRuntime } from "@/transport/runtimes"
import { basename } from "@/features/sessions/useSessionIndex"
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

type PanelMode = "main" | "agent" | "model" | "variant" | "mcp" | "skill" | "voice"

export default function WorkspaceScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string; session?: string; new?: string }>()
  const hostId = params.hostId
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(workspaceStyles)
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const ready = connection?.status === "ready"
  const readOnly = connection?.session?.device?.scope === "read"

  const [sessionId, setSessionId] = useState<string | undefined>(typeof params.session === "string" ? params.session : undefined)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [messages, setMessages] = useState<SessionMessage[] | null>(null)
  const [children, setChildren] = useState<SessionInfo[]>([])
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [loadingSession, setLoadingSession] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<FormInfo[]>([])
  const [dockBusy, setDockBusy] = useState(false)
  const [olderCursor, setOlderCursor] = useState<string | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelMode, setPanelMode] = useState<PanelMode>("main")
  const [activityOpen, setActivityOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [mcp, setMcp] = useState<McpServer[] | null>(null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [optionsBusy, setOptionsBusy] = useState(false)
  const [optionError, setOptionError] = useState<string | null>(null)
  const [modelQuery, setModelQuery] = useState("")
  const [voiceOverride, setVoiceOverride] = useState<VoiceEnginePreference | undefined>(undefined)
  const [phoneModelReady, setPhoneModelReady] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<FlatList<SessionMessage>>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  useEffect(() => {
    if (!hostId) return
    void ensureConnection(hostId).catch(() => undefined)
  }, [hostId])

  useEffect(() => {
    if (!ready || models) return
    let cancelled = false
    void (async () => {
      try {
        const runtime = await ensureConnection(hostId)
        const list = await new OpencodeClient(runtime).listModels()
        if (!cancelled) setModels(list)
      } catch {
        // The status bar falls back to the model id when metadata is unavailable.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hostId, models, ready])

  useEffect(() => {
    const next = typeof params.session === "string" ? params.session : undefined
    if (next && next !== sessionIdRef.current) setSessionId(next)
  }, [params.session])

  useEffect(() => {
    setVoiceOverride(undefined)
    void loadSessionVoiceEngine(sessionId ?? "").then(setVoiceOverride).catch(() => undefined)
  }, [sessionId])

  useEffect(() => {
    void listMobileModels()
      .then((items) => setPhoneModelReady(items.some((item) => item.installed)))
      .catch(() => setPhoneModelReady(false))
  }, [])

  const hostTranscribe =
    connection?.session?.asr?.host?.available === true
      ? async (wav: Uint8Array, durationMs: number): Promise<string> => {
          const runtime = await ensureConnection(hostId)
          const result = await runtime.transcribe({ audio: wav, mime: "audio/wav", durationMs, language: "zh" })
          return result.text
        }
      : undefined

  const dictation = useVoiceInput(
    (text) => {
      setDraft((current) => (current ? `${current.replace(/\s+$/u, "")} ${text}` : text))
    },
    { ...(hostTranscribe ? { hostTranscribe } : {}), ...(voiceOverride ? { preference: voiceOverride } : {}) },
  )

  const notify = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 3_000)
  }, [])

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      if (loadTimer.current) clearTimeout(loadTimer.current)
    },
    [],
  )

  const loadSession = useCallback(
    async (id: string, options: { initial?: boolean } = {}) => {
      if (options.initial) {
        setMessages(null)
        setSession(null)
        setOlderCursor(undefined)
        setInbox([])
        setChildren([])
        setLoadingSession(true)
      }
      setError(null)
      try {
        const runtime = await ensureConnection(hostId)
        const client = new OpencodeClient(runtime)
        const [detail, page, pendingPermissions, pendingForms, queued, childPage] = await Promise.all([
          client.getSession(id),
          client.listMessages(id, { limit: 60, order: "desc" }),
          client.listPermissions(id).catch(() => []),
          client.listForms(id).catch(() => []),
          client.listInbox(id).catch(() => []),
          client.listSessions({ parentID: id, limit: 50, order: "desc" }).catch(() => ({ data: [] as SessionInfo[] })),
        ])
        if (sessionIdRef.current !== id) return
        setSession(detail)
        setPermissions(pendingPermissions)
        setForms(pendingForms)
        setInbox(queued)
        setChildren(childPage.data)
        const latest = [...page.data].reverse()
        if (options.initial) {
          setMessages(latest)
          setOlderCursor(page.data.length >= 60 ? page.cursor?.next : undefined)
        } else {
          setMessages((current) => mergeMessages(latest, current ?? []))
        }
      } catch (cause) {
        if (sessionIdRef.current !== id) return
        setError(cause instanceof Error ? cause.message : t("error"))
      } finally {
        if (sessionIdRef.current === id) setLoadingSession(false)
      }
    },
    [hostId, t],
  )

  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      setMessages(null)
      setChildren([])
      setInbox([])
      setPermissions([])
      setForms([])
      return
    }
    void loadSession(sessionId, { initial: true })
  }, [sessionId, loadSession])

  const refreshFromEvents = useCallback(
    async (id: string, kinds: Set<string>) => {
      try {
        const runtime = await ensureConnection(hostId)
        const client = new OpencodeClient(runtime)
        const tasks: Array<Promise<unknown>> = []
        if (kinds.has("session")) {
          tasks.push(
            client.getSession(id).then((detail) => {
              if (sessionIdRef.current === id) setSession(detail)
            }),
            client
              .listInbox(id)
              .then((items) => {
                if (sessionIdRef.current === id) setInbox(items)
              })
              .catch(() => undefined),
            client
              .listSessions({ parentID: id, limit: 50, order: "desc" })
              .then((page) => {
                if (sessionIdRef.current === id) setChildren(page.data)
              })
              .catch(() => undefined),
          )
        }
        if (kinds.has("message")) {
          tasks.push(
            client.listMessages(id, { limit: 40, order: "desc" }).then((page) => {
              if (sessionIdRef.current !== id) return
              setMessages((current) => mergeMessages([...page.data].reverse(), current ?? []))
            }),
          )
        }
        if (kinds.has("permission")) {
          tasks.push(
            client
              .listPermissions(id)
              .then((items) => {
                if (sessionIdRef.current === id) setPermissions(items)
              })
              .catch(() => undefined),
          )
        }
        if (kinds.has("form")) {
          tasks.push(
            client
              .listForms(id)
              .then((items) => {
                if (sessionIdRef.current === id) setForms(items)
              })
              .catch(() => undefined),
          )
        }
        await Promise.allSettled(tasks)
      } catch {
        // The next event or foreground sync retries.
      }
    },
    [hostId],
  )

  useEffect(() => {
    if (!both(hostId, sessionId)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastRefresh = 0
    const pendingKinds = new Set<string>()
    const scheduleRefresh = () => {
      if (timer) return
      // Throttle rather than debounce: token deltas can arrive continuously for
      // many seconds, and resetting a timer on every delta would postpone the
      // transcript update until the turn is already over.
      const wait = Math.max(0, 250 - (Date.now() - lastRefresh))
      timer = setTimeout(() => {
        timer = undefined
        lastRefresh = Date.now()
        const kinds = new Set(pendingKinds)
        pendingKinds.clear()
        if (sessionIdRef.current) void refreshFromEvents(sessionIdRef.current, kinds)
      }, wait)
    }
    const unsubscribe = subscribeHostEvents(hostId, (event) => {
      if (!event.type) return
      // OpenCode 2 streams content as `session.text.delta`,
      // `session.reasoning.*`, `session.tool.*` and `session.step.*` events,
      // not only as `message.*` events. Treat every session event as a content
      // change so the transcript refreshes while the agent is working instead
      // of only after leaving and re-entering the screen.
      const contentEvent = /^(?:message\.|session\.(?:text|reasoning|tool|step|assistant)\.)/u.test(event.type)
      const sessionEvent = event.type.startsWith("session.") && !contentEvent
      const kind = contentEvent
        ? "message"
        : sessionEvent
          ? "session"
          : event.type.startsWith("permission.")
            ? "permission"
            : event.type.startsWith("form.")
              ? "form"
              : undefined
      if (!kind) return
      pendingKinds.add(kind)
      scheduleRefresh()
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [hostId, refreshFromEvents, sessionId])

  useForeground(
    useCallback(() => {
      void ensureConnection(hostId, { force: true })
        .then(() => (sessionIdRef.current ? loadSession(sessionIdRef.current, { initial: true }) : undefined))
        .catch(() => undefined)
    }, [hostId, loadSession]),
  )

  const loadOlder = async () => {
    if (!sessionId || !olderCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const runtime = await ensureConnection(hostId)
      const page = await new OpencodeClient(runtime).listMessages(sessionId, { limit: 60, cursor: olderCursor })
      const older = [...page.data].reverse()
      setMessages((current) => mergeMessages(older, current ?? []))
      setOlderCursor(page.data.length >= 60 ? page.cursor?.next : undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setLoadingOlder(false)
    }
  }

  const selectSession = (id: string) => {
    setSessionId(id)
    router.setParams({ session: id })
  }

  const openProjectPicker = useCallback(async () => {
    setProjectOpen(true)
    setProjectError(null)
    if (projects) return
    try {
      const runtime = await ensureConnection(hostId)
      setProjects(await new OpencodeClient(runtime).listProjects())
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : t("error"))
    }
  }, [hostId, projects, t])

  useEffect(() => {
    if (params.new !== "1" || !ready) return
    void openProjectPicker()
  }, [params.new, ready, openProjectPicker])

  const createSession = async (project: ProjectInfo) => {
    if (creating) return
    setCreating(true)
    setProjectError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const created = await new OpencodeClient(runtime).createSession({ location: { directory: project.canonical } })
      invalidateSessionIndex(hostId)
      setProjectOpen(false)
      selectSession(created.id)
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setCreating(false)
    }
  }

  const loadOptions = useCallback(
    async (force = false) => {
      if (!force && agents && models && mcp && skills) return
      setOptionsBusy(true)
      setOptionError(null)
      try {
        const runtime = await ensureConnection(hostId)
        const client = new OpencodeClient(runtime)
        const directory = session?.location?.directory
        const [agentList, modelList, mcpList, skillList] = await Promise.all([
          client.listAgents(directory),
          client.listModels(directory),
          client.listMcp(directory).catch(() => []),
          client.listSkills(directory).catch(() => []),
        ])
        setAgents(agentList)
        setModels(modelList)
        setMcp(mcpList)
        setSkills(skillList)
      } catch (cause) {
        setOptionError(cause instanceof Error ? cause.message : t("error"))
      } finally {
        setOptionsBusy(false)
      }
    },
    [agents, hostId, mcp, models, session?.location?.directory, skills, t],
  )

  const refreshMcp = useCallback(async () => {
    try {
      const runtime = await ensureConnection(hostId)
      setMcp(await new OpencodeClient(runtime).listMcp(session?.location?.directory))
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    }
  }, [hostId, session?.location?.directory, t])

  const openPanel = () => {
    setPanelMode("main")
    setPanelOpen(true)
    void loadOptions()
  }

  const selectAgent = async (agentId: string) => {
    if (!sessionId) return
    setOptionsBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).switchAgent(sessionId, agentId)
      setSession((current) => (current ? { ...current, agent: agentId } : current))
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const selectModel = async (model: ModelInfo) => {
    if (!sessionId) return
    setOptionsBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).switchModel(sessionId, {
        id: model.modelID,
        providerID: model.providerID,
        ...(session?.model?.variant ? { variant: session.model.variant } : {}),
      })
      setSession((current) =>
        current ? { ...current, model: { id: model.modelID, providerID: model.providerID } } : current,
      )
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const selectVariant = async (variant?: string) => {
    if (!sessionId || !session?.model?.id || !session.model.providerID) return
    setOptionsBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).switchModel(sessionId, {
        id: session.model.id,
        providerID: session.model.providerID,
        ...(variant ? { variant } : {}),
      })
      setSession((current) =>
        current
          ? {
              ...current,
              model: {
                id: session.model!.id,
                providerID: session.model!.providerID,
                ...(variant ? { variant } : {}),
              },
            }
          : current,
      )
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const toggleMcp = async (server: McpServer) => {
    setOptionsBusy(true)
    setOptionError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const client = new OpencodeClient(runtime)
      await client.setMcpConnected(server.name, server.status?.status !== "connected", session?.location?.directory)
      await refreshMcp()
    } catch (cause) {
      setOptionError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setOptionsBusy(false)
    }
  }

  const chooseVoice = async (value: VoiceEnginePreference) => {
    setVoiceOverride(value)
    if (sessionId) await saveSessionVoiceEngine(sessionId, value).catch(() => undefined)
  }

  const activities = useMemo(
    () => (session ? runningActivities(messages ?? [], children) : []),
    [children, messages, session],
  )
  const active =
    (session ? sessionBusy(session) : false) ||
    activities.length > 0 ||
    children.some(sessionBusy) ||
    inbox.length > 0

  const send = async () => {
    const text = draft.trim()
    if (!text || sending || !sessionId || !ready || readOnly) return
    setSending(true)
    setError(null)
    setDraft("")
    const queued = active
    const optimistic: SessionMessage | null = queued
      ? null
      : { id: `local_${Date.now()}`, type: "user", text, time: { created: Date.now() } }
    if (optimistic) setMessages((current) => [...(current ?? []), optimistic])
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).prompt(sessionId, {
        text,
        ...(queued ? { delivery: "queue" as const } : {}),
      })
      if (queued) notify(t("sessionQueueing"))
      await loadSession(sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
      setDraft(text)
      if (optimistic) setMessages((current) => (current ?? []).filter((item) => item.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    if (!sessionId) return
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).interrupt(sessionId)
      await loadSession(sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    }
  }

  const stopActivity = async (activity: RunningActivity) => {
    if (activity.kind === "shell") return
    try {
      const runtime = await ensureConnection(hostId)
      const target = activity.kind === "subagent" ? activity.sessionId : sessionId
      if (target) await new OpencodeClient(runtime).interrupt(target)
      if (sessionId) await loadSession(sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    }
  }

  const cancelQueued = async (item: InboxItem) => {
    if (!sessionId) return
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).cancelInbox(sessionId, item.id)
      setInbox((current) => current.filter((entry) => entry.id !== item.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
    }
  }

  const replyPermission = async (request: PermissionRequest, decision: "once" | "always" | "reject") => {
    if (!sessionId) return
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
    if (!sessionId) return
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
    if (!sessionId) return
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

  const displayMessages = useMemo(() => mergeAssistantRuns(messages ?? []).reverse(), [messages])
  const currentModel = useMemo(
    () =>
      models?.find(
        (model) => model.modelID === session?.model?.id && model.providerID === session?.model?.providerID,
      ),
    [models, session?.model?.id, session?.model?.providerID],
  )
  const usage = useMemo(() => contextUsage(messages ?? [], currentModel), [messages, currentModel])
  const modelGroups = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    const filtered = (models ?? []).filter((model) => {
      if (!query) return true
      return (
        model.name.toLowerCase().includes(query) ||
        model.modelID.toLowerCase().includes(query) ||
        model.providerID.toLowerCase().includes(query)
      )
    })
    const groups = new Map<string, ModelInfo[]>()
    for (const model of filtered) {
      const group = groups.get(model.providerID) ?? []
      group.push(model)
      groups.set(model.providerID, group)
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [modelQuery, models])

  const systemVoiceReady = useMemo(() => {
    try {
      return ExpoSpeechRecognitionModule.isRecognitionAvailable()
    } catch {
      return false
    }
  }, [])
  const hostVoiceReady = connection?.session?.asr?.host?.available === true
  const anyVoiceReady = phoneModelReady || hostVoiceReady || systemVoiceReady
  const voiceReady =
    voiceOverride === "local"
      ? phoneModelReady
      : voiceOverride === "host"
        ? hostVoiceReady
        : voiceOverride === "system"
          ? systemVoiceReady
          : anyVoiceReady

  const goHosts = () => {
    if (router.canDismiss()) router.dismissTo("/")
    else router.replace("/")
  }

  const statusLabel = statusText(connection?.status, t)
  const title = session?.title?.trim() || t("sessions")
  const agentName = session?.agent ?? t("defaultAgent")
  const modelName = currentModel?.name ?? session?.model?.id ?? t("defaultModel")
  const variantName = session?.model?.variant ?? t("reasoningDefault")
  const contextTokens = usage ? formatTokens(usage.tokens) : t("noContext")
  const contextLimit = usage?.limit ? ` / ${formatTokens(usage.limit)}` : ""
  const statusParts = [
    { text: agentName },
    { text: modelName },
    { text: variantName },
    { text: `${contextTokens}${contextLimit}` },
    ...(usage?.percent !== undefined
      ? [{ text: `${usage.percent}%`, danger: usage.percent >= 80, strong: true }]
      : []),
  ]

  if (!hydrated) return <View style={styles.screen} />

  if (!host) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 40, alignItems: "center" }]}>
        <Text style={styles.emptyTitle}>{t("hostMissing")}</Text>
        <View style={{ marginTop: 18 }}>
          <Button label={t("backToHosts")} onPress={() => router.replace("/")} />
        </View>
      </View>
    )
  }

  const connecting = !ready && !["error", "closed"].includes(connection?.status ?? "idle")

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <IconButton label={t("backToHosts")} onPress={goHosts}>
          <Icon name="back" size={22} color={colors.text} />
        </IconButton>
        <IconButton label={t("sessions")} onPress={() => setDrawerOpen(true)}>
          <Icon name="menu" size={22} color={colors.text} />
        </IconButton>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.headerMeta}>
            {active ? <RunningDot /> : <View style={[styles.dot, { backgroundColor: ready ? colors.success : colors.faint }]} />}
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {active ? t("running") : ready ? t("connected") : statusLabel}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <IconButton
            label={t("review")}
            disabled={!sessionId}
            onPress={() =>
              sessionId
                ? router.push({
                    pathname: "/hosts/[hostId]/sessions/[sessionId]/review",
                    params: { hostId, sessionId, directory: session?.location?.directory ?? "" },
                  })
                : undefined
            }
          >
            <Icon name="edit" size={20} color={sessionId ? colors.muted : colors.faint} />
          </IconButton>
          <IconButton
            label={t("diff")}
            disabled={!sessionId}
            onPress={() =>
              sessionId
                ? router.push({
                    pathname: "/hosts/[hostId]/sessions/[sessionId]/diff",
                    params: { hostId, sessionId },
                  })
                : undefined
            }
          >
            <Icon name="diff" size={20} color={sessionId ? colors.muted : colors.faint} />
          </IconButton>
        </View>
      </View>

      {!ready ? (
        <View style={styles.connectionState}>
          {connecting ? (
            <>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.connectionText}>{t("connectingHost")}</Text>
            </>
          ) : (
            <>
              <Icon name="server" size={30} color={colors.faint} />
              <Text style={styles.connectionTitle}>{t("hostOffline")}</Text>
              <Text style={styles.connectionText}>{connection?.error?.message ?? t("hostOfflineBody")}</Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
                <Button label={t("retry")} size="sm" onPress={() => void ensureConnection(hostId, { force: true }).catch(() => undefined)} />
                <Button label={t("hostList")} size="sm" variant="outline" onPress={goHosts} />
              </View>
            </>
          )}
        </View>
      ) : !sessionId ? (
        <View style={styles.connectionState}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.accentSoft }]}>
            <Icon name="message" size={28} color={colors.accent} />
          </View>
          <Text style={styles.connectionTitle}>{t("sessionEmptyTitle")}</Text>
          <Text style={styles.connectionText}>{t("sessionEmptyBody")}</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
            <Button label={t("newSession")} size="sm" disabled={readOnly} onPress={() => void openProjectPicker()} />
            <Button label={t("allSessions")} size="sm" variant="outline" onPress={() => setDrawerOpen(true)} />
          </View>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {loadingSession && messages === null ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.connectionText}>{t("syncingSession")}</Text>
            </View>
          ) : (
            <FlatList
              key={sessionId}
              ref={listRef}
              inverted
              data={displayMessages}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => <MessageView message={item} />}
              contentContainerStyle={styles.messages}
              keyboardShouldPersistTaps="handled"
              onEndReached={() => void loadOlder()}
              onEndReachedThreshold={0.25}
              onScroll={(event) => setShowJump(event.nativeEvent.contentOffset.y > 240)}
              scrollEventThrottle={100}
              removeClippedSubviews={Platform.OS === "android"}
              ListFooterComponent={
                olderCursor ? (
                  <Pressable accessibilityRole="button" onPress={() => void loadOlder()} style={styles.olderButton}>
                    <Text style={styles.olderText}>{loadingOlder ? t("loadingOlder") : t("loadOlder")}</Text>
                  </Pressable>
                ) : (
                  <View style={{ height: 4 }} />
                )
              }
              ListEmptyComponent={
                <Text style={[styles.emptyMessages, { transform: [{ scaleY: -1 }] }]}>{t("noMessages")}</Text>
              }
            />
          )}

          {showJump ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setShowJump(false)
                listRef.current?.scrollToOffset({ offset: 0, animated: true })
              }}
              style={[styles.jump, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <Icon name="chevronDown" size={16} color={colors.muted} />
            </Pressable>
          ) : null}

          {activities.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setActivityOpen(true)}
              style={({ pressed }) => [
                styles.activityPill,
                { backgroundColor: colors.surface, borderColor: colors.border },
                pressed && { opacity: 0.75 },
              ]}
            >
              <Icon name="activity" size={14} color={colors.warning} />
              <Text style={styles.activityText}>{t("backgroundRunning", { n: activities.length })}</Text>
              <Icon name="chevronRight" size={14} color={colors.faint} />
            </Pressable>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <PendingDock
            permissions={permissions}
            forms={forms}
            busy={dockBusy || readOnly}
            onReplyPermission={(request, decision) => void replyPermission(request, decision)}
            onSubmitForm={(form, answer) => void submitForm(form, answer)}
            onCancelForm={(form) => void cancelForm(form)}
          />

          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {inbox.length > 0 ? (
              <View style={styles.queueBox}>
                {inbox.map((item) => (
                  <View key={item.id} style={styles.queueRow}>
                    <Icon name="activity" size={12} color={colors.warning} />
                    <Text style={styles.queueText} numberOfLines={1}>
                      {item.payload?.text ?? item.type}
                    </Text>
                    <Pressable accessibilityRole="button" onPress={() => void cancelQueued(item)} hitSlop={8}>
                      <Icon name="close" size={13} color={colors.faint} />
                    </Pressable>
                  </View>
                ))}
                <Text style={styles.queueHint}>{t("queuedCount", { n: inbox.length })}</Text>
              </View>
            ) : null}

            {dictation.listening || dictation.transcribing || dictation.error ? (
              <View style={styles.voiceBar}>
                {dictation.transcribing ? <ActivityIndicator size="small" color={colors.accent} /> : null}
                <Text style={[styles.voiceText, dictation.error && { color: colors.danger }]} numberOfLines={2}>
                  {dictation.error
                    ? dictation.error
                    : dictation.transcribing
                      ? dictation.engine === "host"
                        ? t("transcribingHost")
                        : t("transcribingLocal")
                      : dictation.engine === "local"
                        ? t("listeningLocal")
                        : dictation.engine === "host"
                          ? t("listeningHost")
                          : t("listeningSystem")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => (dictation.error ? dictation.clearError() : dictation.stop())}
                  hitSlop={8}
                >
                  <Text style={styles.voiceStop}>{dictation.error ? t("close") : t("stop")}</Text>
                </Pressable>
              </View>
            ) : null}

            {notice ? <Text style={styles.notice}>{notice}</Text> : null}

            <View style={styles.composerRow}>
              <TextInput
                editable={ready && !sending && !readOnly}
                multiline
                onChangeText={setDraft}
                placeholder={readOnly ? t("readOnlyDevice") : t("messagePlaceholder")}
                placeholderTextColor={colors.faint}
                style={styles.input}
                value={draft}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("dictation")}
                disabled={!ready || readOnly || sending || dictation.transcribing || !voiceReady}
                onPress={() => (dictation.listening ? dictation.stop() : void dictation.start("zh-CN"))}
                style={({ pressed }) => [
                  styles.iconAction,
                  (!ready || readOnly || sending || !voiceReady) && { opacity: 0.32 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Icon name="mic" size={19} color={dictation.listening ? colors.accent : colors.muted} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("send")}
                disabled={!ready || sending || readOnly || draft.trim().length === 0}
                onPress={() => void send()}
                style={({ pressed }) => [
                  styles.sendButton,
                  { backgroundColor: colors.accent },
                  (!ready || sending || readOnly || draft.trim().length === 0) && { opacity: 0.32 },
                  pressed && { opacity: 0.75 },
                ]}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={colors.accentText} />
                ) : (
                  <Icon name="arrowUp" size={19} color={colors.accentText} />
                )}
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={openPanel}
              style={({ pressed }) => [styles.statusBar, pressed && { opacity: 0.7 }]}
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ flex: 1 }}
                contentContainerStyle={styles.statusContent}
              >
                {statusParts.map((part, index) => (
                  <View key={`${index}-${part.text}`} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                    {index > 0 ? <Text style={styles.statusSeparator}>·</Text> : null}
                    <Text
                      style={[
                        styles.statusText,
                        part.strong ? { color: colors.text, fontWeight: "600" } : null,
                        part.danger ? { color: colors.danger } : null,
                      ]}
                      numberOfLines={1}
                    >
                      {part.text}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </Pressable>
          </View>
        </View>
      )}

      <SessionDrawer
        visible={drawerOpen}
        hostId={hostId}
        hostName={host.name}
        statusLabel={statusLabel}
        currentSessionId={sessionId}
        onClose={() => setDrawerOpen(false)}
        onSelect={(next) => selectSession(next.id)}
        onNewSession={() => void openProjectPicker()}
        onSettings={() => router.push({ pathname: "/hosts/[hostId]/edit", params: { hostId } })}
      />

      <BottomSheet
        visible={projectOpen}
        title={t("chooseProject")}
        onClose={() => setProjectOpen(false)}
      >
        {projectError ? <Text style={{ fontSize: 12.5, color: colors.danger, marginBottom: 8 }}>{projectError}</Text> : null}
        {projects === null ? (
          <Text style={styles.sheetMuted}>{t("loadingProjects")}</Text>
        ) : projects.length === 0 ? (
          <Text style={styles.sheetMuted}>{t("noProjects")}</Text>
        ) : (
          projects.map((project) => (
            <Pressable
              key={project.id}
              accessibilityRole="button"
              disabled={creating}
              onPress={() => void createSession(project)}
              style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }]}
            >
              <Icon name="folder" size={18} color={colors.muted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.optionTitle} numberOfLines={1}>
                  {project.name?.trim() || basename(project.canonical)}
                </Text>
                <Text style={styles.optionBody} numberOfLines={1}>
                  {project.canonical}
                </Text>
              </View>
              {creating ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            </Pressable>
          ))
        )}
      </BottomSheet>

      <BottomSheet visible={activityOpen} title={t("backgroundTasks")} onClose={() => setActivityOpen(false)}>
        {activities.length === 0 ? <Text style={styles.sheetMuted}>{t("backgroundNone")}</Text> : null}
        {activities.map((activity) => (
          <View key={activity.key} style={styles.optionRow}>
            <Icon name={activity.kind === "subagent" ? "spark" : activity.kind === "shell" ? "terminal" : "activity"} size={17} color={colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optionTitle} numberOfLines={1}>
                {activity.label}
              </Text>
              <Text style={styles.optionBody}>{activity.kind}</Text>
            </View>
            {activity.kind !== "shell" ? (
              <Button label={t("backgroundStop")} size="sm" variant="outline" onPress={() => void stopActivity(activity)} />
            ) : null}
          </View>
        ))}
        {active ? (
          <View style={{ marginTop: 10 }}>
            <Button label={t("stop")} size="sm" variant="danger" onPress={() => void stop()} />
          </View>
        ) : null}
      </BottomSheet>

      <BottomSheet
        visible={panelOpen}
        title={panelMode === "main" ? t("sessionSettings") : panelTitle(panelMode, t)}
        onClose={() => setPanelOpen(false)}
        maxHeight={680}
      >
        {panelMode !== "main" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setPanelMode("main")
              setModelQuery("")
            }}
            style={styles.backRow}
          >
            <Icon name="back" size={16} color={colors.muted} />
            <Text style={{ fontSize: 13, color: colors.muted }}>{t("back")}</Text>
          </Pressable>
        ) : null}
        {optionsBusy ? <ActivityIndicator style={{ marginVertical: 10 }} color={colors.accent} /> : null}
        {optionError ? <Text style={{ fontSize: 12.5, color: colors.danger, marginBottom: 8 }}>{optionError}</Text> : null}

        {panelMode === "main" ? (
          <View style={{ gap: 2 }}>
            <SheetRow icon="spark" label={t("agent")} value={agentName} onPress={() => setPanelMode("agent")} />
            <SheetRow icon="message" label={t("model")} value={modelName} onPress={() => setPanelMode("model")} />
            <SheetRow icon="sliders" label={t("reasoningDepth")} value={variantName} onPress={() => setPanelMode("variant")} />
            <SheetRow
              icon="activity"
              label={t("mcp")}
              value={mcp ? String(mcp.length) : "—"}
              onPress={() => {
                setPanelMode("mcp")
                void refreshMcp()
              }}
            />
            <SheetRow icon="spark" label={t("skills")} value={skills ? String(skills.length) : "—"} onPress={() => setPanelMode("skill")} />
            <SheetRow icon="mic" label={t("engine")} value={voiceLabel(voiceOverride, t)} onPress={() => setPanelMode("voice")} />
            <View style={styles.panelDivider} />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setPanelOpen(false)
                if (sessionId)
                  router.push({
                    pathname: "/hosts/[hostId]/sessions/[sessionId]/review",
                    params: { hostId, sessionId, directory: session?.location?.directory ?? "" },
                  })
              }}
              style={({ pressed }) => [styles.panelAction, pressed && { opacity: 0.7 }]}
            >
              <Icon name="edit" size={18} color={colors.muted} />
              <Text style={styles.panelActionText}>{t("review")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setPanelOpen(false)
                if (sessionId)
                  router.push({
                    pathname: "/hosts/[hostId]/sessions/[sessionId]/diff",
                    params: { hostId, sessionId },
                  })
              }}
              style={({ pressed }) => [styles.panelAction, pressed && { opacity: 0.7 }]}
            >
              <Icon name="diff" size={18} color={colors.muted} />
              <Text style={styles.panelActionText}>{t("diff")}</Text>
            </Pressable>
          </View>
        ) : null}

        {panelMode === "agent"
          ? (agents ?? [])
              .filter((agent) => agent.mode !== "subagent")
              .map((agent) => (
                <Pressable
                  key={agent.id}
                  accessibilityRole="button"
                  onPress={() => void selectAgent(agent.id)}
                  style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionTitle}>{agent.name}</Text>
                    {agent.description ? (
                      <Text style={styles.optionBody} numberOfLines={2}>
                        {agent.description}
                      </Text>
                    ) : null}
                  </View>
                  {agent.id === session?.agent ? <Icon name="check" size={18} color={colors.accent} /> : null}
                </Pressable>
              ))
          : null}

        {panelMode === "model" ? (
          <View>
            <View style={styles.searchBox}>
              <Icon name="search" size={15} color={colors.faint} />
              <TextInput
                value={modelQuery}
                onChangeText={setModelQuery}
                placeholder={t("search")}
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.searchInput}
              />
            </View>
            {modelGroups.map(([provider, list]) => (
              <View key={provider} style={{ marginTop: 6 }}>
                <Text style={styles.providerLabel}>{provider}</Text>
                {list.map((model) => {
                  const selected =
                    model.modelID === session?.model?.id && model.providerID === session?.model?.providerID
                  return (
                    <Pressable
                      key={`${model.providerID}/${model.modelID}`}
                      accessibilityRole="button"
                      onPress={() => void selectModel(model)}
                      style={({ pressed }) => [styles.modelRow, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={[styles.modelName, selected && { color: colors.accent }]} numberOfLines={1}>
                        {model.name}
                      </Text>
                      {selected ? <Icon name="check" size={17} color={colors.accent} /> : null}
                    </Pressable>
                  )
                })}
              </View>
            ))}
          </View>
        ) : null}

        {panelMode === "variant" ? (
          <View>
            {(currentModel?.variants ?? []).length === 0 ? (
              <Text style={styles.sheetMuted}>{t("reasoningUnsupported")}</Text>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void selectVariant(undefined)}
                  style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.optionTitle, { flex: 1 }]}>{t("reasoningDefault")}</Text>
                  {!session?.model?.variant ? <Icon name="check" size={18} color={colors.accent} /> : null}
                </Pressable>
                {(currentModel?.variants ?? []).map((variant) => (
                  <Pressable
                    key={variant.id}
                    accessibilityRole="button"
                    onPress={() => void selectVariant(variant.id)}
                    style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.optionTitle, { flex: 1 }]}>{variant.id}</Text>
                    {session?.model?.variant === variant.id ? <Icon name="check" size={18} color={colors.accent} /> : null}
                  </Pressable>
                ))}
              </>
            )}
          </View>
        ) : null}

        {panelMode === "mcp" ? (
          <View>
            <Text style={styles.sheetMuted}>{t("mcpHint")}</Text>
            {mcp === null ? <Text style={styles.sheetMuted}>{t("loading")}</Text> : null}
            {mcp?.length === 0 ? <Text style={styles.sheetMuted}>{t("noMcp")}</Text> : null}
            {(mcp ?? []).map((server) => {
              const status = server.status?.status ?? "unknown"
              const connected = status === "connected"
              return (
                <Pressable
                  key={server.name}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: connected, disabled: optionsBusy }}
                  disabled={optionsBusy}
                  onPress={() => void toggleMcp(server)}
                  style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }, optionsBusy && { opacity: 0.6 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionTitle}>{server.title?.trim() || server.name}</Text>
                    <Text style={[styles.optionBody, status === "failed" && { color: colors.danger }]}>
                      {mcpStatusLabel(status, t)}
                    </Text>
                  </View>
                  <Badge text={connected ? t("on") : t("off")} tone={connected ? "success" : "neutral"} />
                </Pressable>
              )
            })}
          </View>
        ) : null}

        {panelMode === "skill" ? (
          <View>
            <Text style={styles.sheetMuted}>{t("skillHint")}</Text>
            {skills === null ? <Text style={styles.sheetMuted}>{t("loading")}</Text> : null}
            {skills?.length === 0 ? <Text style={styles.sheetMuted}>{t("noSkills")}</Text> : null}
            {(skills ?? []).map((skill) => (
              <View key={skill.id} style={styles.optionRow}>
                <Icon name="spark" size={16} color={colors.muted} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={styles.optionTitle}>{skill.name}</Text>
                    {skill.autoinvoke ? <Badge text={t("autoInvoke")} tone="accent" /> : null}
                  </View>
                  {skill.description ? (
                    <Text style={styles.optionBody} numberOfLines={2}>
                      {skill.description}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {panelMode === "voice" ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.sheetMuted}>{t("engineAutoHint")}</Text>
            <VoiceOption
              label={t("engineAuto")}
              hint={t("engineAutoHint")}
              ready={anyVoiceReady}
              selected={(voiceOverride ?? "auto") === "auto"}
              onPress={() => void chooseVoice("auto")}
            />
            <VoiceOption
              label={t("engineLocal")}
              hint={t("engineNoPhoneModel")}
              ready={phoneModelReady}
              selected={voiceOverride === "local"}
              onPress={() => void chooseVoice("local")}
            />
            <VoiceOption
              label={t("engineHost")}
              hint={t("engineNoHostModel")}
              ready={hostVoiceReady}
              selected={voiceOverride === "host"}
              onPress={() => void chooseVoice("host")}
            />
            <VoiceOption
              label={t("engineSystem")}
              hint={t("engineNoSystem")}
              ready={systemVoiceReady}
              selected={voiceOverride === "system"}
              onPress={() => void chooseVoice("system")}
            />
          </View>
        ) : null}
      </BottomSheet>
    </KeyboardAvoidingView>
  )
}

function SheetRow(props: {
  icon: "spark" | "message" | "sliders" | "activity" | "mic"
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
        { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Icon name={props.icon} size={18} color={colors.muted} />
      <Text style={{ flex: 1, fontSize: 14.5, color: colors.text }}>{props.label}</Text>
      <Text style={{ maxWidth: "48%", fontSize: 12.5, color: colors.faint }} numberOfLines={1}>
        {props.value}
      </Text>
      <Icon name="chevronRight" size={15} color={colors.faint} />
    </Pressable>
  )
}

function VoiceOption(props: {
  label: string
  hint: string
  ready: boolean
  selected: boolean
  onPress: () => void
}) {
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !props.ready, selected: props.selected }}
      disabled={!props.ready}
      onPress={props.onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 11,
          paddingHorizontal: 4,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          opacity: props.ready ? 1 : 0.4,
        },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: props.ready ? colors.success : colors.faint }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, color: colors.text }}>{props.label}</Text>
        <Text style={{ fontSize: 11.5, color: colors.faint, marginTop: 1 }}>
          {props.ready ? "" : props.hint}
        </Text>
      </View>
      {props.selected ? <Icon name="check" size={18} color={colors.accent} /> : null}
    </Pressable>
  )
}

function RunningDot() {
  const { colors } = useTheme()
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.warning }} />
}

function statusText(status: string | undefined, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "ready":
      return t("connected")
    case "connecting":
    case "handshaking":
    case "authenticating":
      return t("connecting")
    case "reconnecting":
      return t("reconnecting")
    case "error":
      return t("offline")
    default:
      return t("notConnected")
  }
}

function mcpStatusLabel(status: string, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "connected":
      return t("mcpConnected")
    case "disabled":
      return t("mcpDisabled")
    case "pending":
      return t("mcpPending")
    case "needs_auth":
      return t("mcpNeedsAuth")
    case "failed":
      return t("mcpFailed")
    default:
      return status
  }
}

function panelTitle(mode: PanelMode, t: ReturnType<typeof useT>): string {
  switch (mode) {
    case "agent":
      return t("agent")
    case "model":
      return t("model")
    case "variant":
      return t("reasoningDepth")
    case "mcp":
      return t("mcp")
    case "skill":
      return t("skills")
    case "voice":
      return t("engine")
    default:
      return t("sessionSettings")
  }
}

function voiceLabel(value: VoiceEnginePreference | undefined, t: ReturnType<typeof useT>): string {
  if (value === "local") return t("engineLocal")
  if (value === "host") return t("engineHost")
  if (value === "system") return t("engineSystem")
  return t("engineAuto")
}

/**
 * OpenCode may split one assistant turn across several messages. Rendering each
 * message separately breaks a continuous run of reasoning/tool calls into many
 * tiny collapsible groups. Merge adjacent assistant messages so the existing
 * text/activity grouping sees the whole turn; a visible text block still splits
 * the activity groups.
 */
function mergeAssistantRuns(messages: SessionMessage[]): SessionMessage[] {
  const result: SessionMessage[] = []
  let run: SessionMessage[] = []
  const flush = () => {
    if (run.length === 0) return
    if (run.length === 1) {
      result.push(run[0] as SessionMessage)
      run = []
      return
    }
    const first = run[0] as SessionMessage
    const last = run[run.length - 1] as SessionMessage
    const content = run.flatMap((message) => message.content ?? [])
    const errors = run
      .map((message) => message.error?.message)
      .filter((message): message is string => Boolean(message))
    result.push({
      ...first,
      ...(content.length > 0 ? { content } : {}),
      ...(last.time ? { time: last.time } : {}),
      ...(errors.length > 0 ? { error: { message: errors.join("\n") } } : {}),
    })
    run = []
  }
  for (const message of messages) {
    if (message.type === "assistant") {
      run.push(message)
      continue
    }
    flush()
    result.push(message)
  }
  flush()
  return result
}

function mergeMessages(incoming: SessionMessage[], existing: SessionMessage[]): SessionMessage[] {
  const byId = new Map<string, SessionMessage>()
  for (const message of existing) {
    if (!message.id.startsWith("local_")) byId.set(message.id, message)
  }
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => toMillis(left.time?.created) - toMillis(right.time?.created))
}

function both(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right)
}

const workspaceStyles = (colors: Palette) =>
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
    headerTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
    headerMeta: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    headerSubtitle: { fontSize: 11, color: colors.muted },
    headerActions: { flexDirection: "row", alignItems: "center" },
    connectionState: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 10 },
    connectionTitle: { fontSize: 19, fontWeight: "700", color: colors.text, textAlign: "center" },
    emptyTitle: { fontSize: 19, fontWeight: "600", color: colors.text },
    connectionText: { fontSize: 13, lineHeight: 20, color: colors.muted, textAlign: "center", maxWidth: 320 },
    emptyIcon: { width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center", marginBottom: 4 },
    loadingState: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
    messages: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, gap: 12 },
    emptyMessages: { textAlign: "center", color: colors.faint, fontSize: 13, paddingVertical: 24 },
    olderButton: { alignSelf: "center", paddingVertical: 10, paddingHorizontal: 16 },
    olderText: { fontSize: 12, color: colors.faint },
    jump: {
      position: "absolute",
      right: 16,
      bottom: 12,
      width: 38,
      height: 38,
      borderRadius: 19,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: "center",
      justifyContent: "center",
    },
    activityPill: {
      marginHorizontal: 14,
      marginBottom: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      alignSelf: "flex-start",
    },
    activityText: { fontSize: 12, fontWeight: "600", color: colors.muted },
    error: { marginHorizontal: 16, marginBottom: 4, fontSize: 12.5, color: colors.danger },
    composer: { paddingHorizontal: 10, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.bg },
    queueBox: {
      marginHorizontal: 4,
      marginBottom: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 10,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 3,
    },
    queueRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    queueText: { flex: 1, fontSize: 11.5, color: colors.muted },
    queueHint: { fontSize: 10.5, color: colors.faint },
    voiceBar: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 4, marginBottom: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.surface },
    voiceText: { flex: 1, fontSize: 12, color: colors.muted },
    voiceStop: { fontSize: 12, fontWeight: "600", color: colors.accent },
    notice: { marginHorizontal: 6, marginBottom: 5, fontSize: 11.5, color: colors.muted },
    composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
    input: {
      flex: 1,
      minHeight: 42,
      maxHeight: 150,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 10,
      fontSize: 15,
      lineHeight: 21,
      color: colors.text,
    },
    iconAction: { width: 36, height: 42, alignItems: "center", justifyContent: "center" },
    sendButton: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", marginBottom: 2 },
    statusBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 4, marginTop: 2 },
    statusContent: { gap: 7, alignItems: "center", paddingRight: 6, flexGrow: 1, justifyContent: "center" },
    statusText: { fontSize: 11.5, color: colors.muted },
    statusSeparator: { fontSize: 11.5, color: colors.faint },
    sheetMuted: { fontSize: 12.5, lineHeight: 18, color: colors.faint, marginTop: 4 },
    optionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    optionTitle: { fontSize: 14.5, fontWeight: "500", color: colors.text },
    optionBody: { fontSize: 11.5, color: colors.faint, marginTop: 2 },
    backRow: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6 },
    panelDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 5 },
    panelAction: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 2 },
    panelActionText: { fontSize: 14, color: colors.text },
    searchBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      height: 38,
      borderRadius: 10,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      paddingHorizontal: 10,
      marginTop: 4,
    },
    searchInput: { flex: 1, fontSize: 13.5, color: colors.text, paddingVertical: 0 },
    providerLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, color: colors.faint, marginTop: 12, marginBottom: 2, textTransform: "uppercase" },
    modelRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingLeft: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    modelName: { flex: 1, fontSize: 14, color: colors.text },
  })
