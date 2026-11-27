import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition"
import { BottomSheet, useBottomSheetHeight } from "@/components/BottomSheet"
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
  type AssistantContent,
  type BackgroundJob,
  type CommandInfo,
  type DirectoryCheck,
  type DirectoryListing,
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
import { appendReviewText, buildReviewPrompt, type ReviewComment } from "@/opencode/review"
import { contextUsage, formatTokens, runningActivities, type RunningActivity } from "@/features/session/activity"
import { describeError, isMissingSession } from "@/features/session/errors"
import {
  CORE_COMMANDS,
  findCoreCommand,
  isUnavailableCommand,
  UNAVAILABLE_COMMANDS,
  type CoreCommandAction,
} from "@/features/session/commands"
import { clearSessionDraft, readSessionDraft, useSessionDraft, writeSessionDraft } from "@/features/session/drafts"
import {
  deleteSessionCache,
  readSessionCache,
  updateSessionOffset,
  writeSessionCache,
  type SessionSnapshot,
} from "@/features/session/sessionCache"
import {
  mergeMessages,
  reconcileTranscript,
  sessionRefreshKinds,
  shouldFollow,
  type SessionRefreshKind,
} from "@/features/session/sync"
import { SessionStreamController, STREAM_FRAME_MS } from "@/features/session/streamController"
import { invalidateSessionIndex } from "@/features/sessions/useSessionIndex"
import { visiblePrimaryAgents } from "@/lib/agents"
import { appendVoiceText } from "@/features/voice/dictationText"
import { listMobileModels } from "@/features/voice/models"
import { useVoiceInput, type VoiceEngine } from "@/features/voice/useVoiceInput"
import { ensureConnection, subscribeHostEvents, closeRuntime } from "@/transport/runtimes"
import type { OpencodeEvent } from "@/transport/hostEvents"
import { basename } from "@/features/sessions/useSessionIndex"
import {
  loadSessionVoiceEngine,
  saveSessionVoiceEngine,
  usePreferences,
  type VoiceEnginePreference,
} from "@/stores/preferences"
import { clearLastSession, loadLastSession, saveLastSession } from "@/storage/lastSession"
import { useTheme, useThemedStyles, type Palette } from "@/theme"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { useReviewDrafts, useStagedReview } from "@/stores/reviewDrafts"

type PanelMode = "main" | "agent" | "model" | "variant" | "mcp" | "skill" | "voice" | "status" | "help"

type CommandChoice = {
  name: string
  aliases: string[]
  description: string
  category: "session" | "agent" | "system" | "server" | "unavailable"
  enabled: boolean
  run: () => void
}

type StagedSkill = {
  id: string
  name: string
}

const EMPTY_MESSAGES: SessionMessage[] = []

const NO_REVIEW_COMMENTS: ReviewComment[] = []

export default function WorkspaceScreen() {
  const insets = useSafeAreaInsets()
  const { width: windowWidth } = useWindowDimensions()
  const panelHeight = useBottomSheetHeight()
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
  const [foreground, setForeground] = useState(AppState.currentState !== "background")
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"))
    return () => subscription.remove()
  }, [])
  // Once the screen has been ready, a later drop must NOT swap the whole
  // workspace for the offline screen: the auto-reconnect cycle used to unmount
  // the transcript on every attempt, which both flickered a full-screen
  // "connecting" state and reset the scroll to the newest message.
  const [everReady, setEverReady] = useState(false)
  useEffect(() => {
    if (ready) setEverReady(true)
  }, [ready])
  const dropped = !ready && everReady
  const readOnly = connection?.session?.device?.scope === "read"

  const [sessionId, setSessionId] = useState<string | undefined>(typeof params.session === "string" ? params.session : undefined)
  const stagedReview = useStagedReview(sessionId)
  const stagedComments = stagedReview?.comments ?? NO_REVIEW_COMMENTS
  const removeStagedComment = useReviewDrafts((state) => state.remove)
  const clearStagedComments = useReviewDrafts((state) => state.clear)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [messages, setMessages] = useState<SessionMessage[] | null>(null)
  const [children, setChildren] = useState<SessionInfo[]>([])
  const [jobState, setJobState] = useState<{ id: string; jobs: BackgroundJob[] }>()
  const [shellState, setShellState] = useState<{ id: string; ids: Set<string> }>()
  const [stopping, setStopping] = useState(false)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [liveState, setLiveState] = useState<{ sessionId?: string; messages: SessionMessage[] }>({ messages: [] })
  const liveMessages = liveState.sessionId === sessionId ? liveState.messages : EMPTY_MESSAGES
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [loadingSession, setLoadingSession] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = useSessionDraft(hostId, sessionId)
  const [draftSelection, setDraftSelection] = useState({ start: 0, end: 0 })
  const [sending, setSending] = useState(false)
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<FormInfo[]>([])
  const [dockBusy, setDockBusy] = useState(false)
  const [olderCursor, setOlderCursor] = useState<string | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [following, setFollowing] = useState(true)
  const [opencodeOnline, setOpencodeOnline] = useState<boolean | undefined>(undefined)
  const [opencodeError, setOpencodeError] = useState<string | null>(null)
  const [directoryInput, setDirectoryInput] = useState("")
  const [dirHome, setDirHome] = useState<string | undefined>(undefined)
  const [treeListings, setTreeListings] = useState<Record<string, DirectoryListing>>({})
  const [treeLoading, setTreeLoading] = useState<Record<string, boolean>>({})
  const [expandedDirs, setExpandedDirs] = useState<string[]>([])
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [directoryCheck, setDirectoryCheck] = useState<DirectoryCheck | null>(null)
  const [directoryChecking, setDirectoryChecking] = useState(false)
  const [directoryTreeOpen, setDirectoryTreeOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerDragging, setDrawerDragging] = useState(false)
  const drawerProgress = useRef(new Animated.Value(0)).current
  const drawerOpenRef = useRef(false)
  const drawerWidth = Math.min(330, Math.round(windowWidth * 0.88))
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelMode, setPanelMode] = useState<PanelMode>("main")
  const panelFade = useRef(new Animated.Value(1)).current
  const panelShift = useRef(new Animated.Value(0)).current
  const [activityOpen, setActivityOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [defaultModel, setDefaultModel] = useState<ModelInfo | null>(null)
  const [mcp, setMcp] = useState<McpServer[] | null>(null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [selectedSkills, setSelectedSkills] = useState<StagedSkill[]>([])
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [optionsBusy, setOptionsBusy] = useState(false)
  const [optionError, setOptionError] = useState<string | null>(null)
  const [modelQuery, setModelQuery] = useState("")
  const [voiceOverride, setVoiceOverride] = useState<VoiceEnginePreference | undefined>(undefined)
  const [phoneModelReady, setPhoneModelReady] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [voiceStage, setVoiceStage] = useState<"closed" | "recording" | "confirm">("closed")
  const listRef = useRef<FlatList<SessionMessage>>(null)
  const inputRef = useRef<TextInput>(null)
  const loadingOlderRef = useRef(false)
  const messageOffsetRef = useRef(0)
  const restoreOffsetRef = useRef<number | undefined>(undefined)
  const oldestMessageIdRef = useRef<string | undefined>(undefined)
  const olderCursorRef = useRef<string | undefined>(undefined)
  const loadOlderRef = useRef<() => void>(() => undefined)
  const streamStartRef = useRef<(() => void) | undefined>(undefined)
  const messagesRef = useRef<SessionMessage[] | null>(null)
  const transcriptRevision = useRef(0)
  const [historySyncError, setHistorySyncError] = useState(false)
  const childrenRef = useRef(children)
  childrenRef.current = children
  const newestMessageRef = useRef<SessionMessage | undefined>(undefined)
  const followingRef = useRef(true)
  const jumpingRef = useRef(false)
  // The jump button dot means "new output arrived while you were scrolled
  // away". It used to light up on any upward scroll and persisted across
  // sessions, which read as phantom unread content.
  const [hasNewContent, setHasNewContent] = useState(false)
  const lastSeenNewestRef = useRef<SessionMessage | undefined>(undefined)
  const statusGesture = useRef({ x: 0, y: 0, scrolled: false })

  const setDraftFor = useCallback(
    (target: string | undefined, value: string | ((current: string) => string)) => {
      if (!target) return
      const current = readSessionDraft(hostId, target)
      writeSessionDraft(hostId, target, typeof value === "function" ? value(current) : value)
    },
    [hostId],
  )
  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => setDraftFor(sessionId, value),
    [sessionId, setDraftFor],
  )

  const openDrawer = useCallback(() => {
    drawerOpenRef.current = true
    setDrawerOpen(true)
    Keyboard.dismiss()
    Animated.timing(drawerProgress, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [drawerProgress])

  const closeDrawer = useCallback(() => {
    drawerOpenRef.current = false
    Animated.timing(drawerProgress, {
      toValue: 0,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setDrawerOpen(false)
    })
  }, [drawerProgress])

  const finishDrawerDrag = useCallback(
    (dx: number, vx: number) => {
      setDrawerDragging(false)
      const next = Math.max(0, Math.min(1, dx / drawerWidth))
      if (next > 0.32 || vx > 0.35) openDrawer()
      else closeDrawer()
    },
    [closeDrawer, drawerWidth, openDrawer],
  )

  const drawerSwipe = useMemo(
    () =>
      PanResponder.create({
        // Capture from the content ScrollView once the finger is clearly moving
        // right, then drive the drawer position directly from dx.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          !drawerOpenRef.current &&
          gesture.dx > 10 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.35,
        onPanResponderGrant: () => {
          setDrawerDragging(true)
          drawerProgress.setValue(0)
          Keyboard.dismiss()
        },
        onPanResponderMove: (_event, gesture) => {
          drawerProgress.setValue(Math.max(0, Math.min(1, gesture.dx / drawerWidth)))
        },
        onPanResponderRelease: (_event, gesture) => finishDrawerDrag(gesture.dx, gesture.vx),
        onPanResponderTerminate: () => finishDrawerDrag(0, 0),
      }),
    [drawerProgress, drawerWidth, finishDrawerDrag],
  )

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!drawerOpenRef.current) return false
      closeDrawer()
      return true
    })
    return () => subscription.remove()
  }, [closeDrawer])
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const sessionIdRef = useRef(sessionId)
  const messagesSessionIdRef = useRef<string | undefined>(undefined)
  sessionIdRef.current = sessionId
  messagesRef.current = messages
  const messagesForSession = messagesSessionIdRef.current === sessionId ? messages : null

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  useEffect(() => {
    if (!hostId || !hydrated || !foreground) return
    void ensureConnection(hostId).catch(() => undefined)
  }, [foreground, hostId, hydrated])

  useEffect(() => {
    if (!ready) return
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
  }, [catalogRevision, hostId, ready])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void (async () => {
      try {
        const runtime = await ensureConnection(hostId)
        const model = await new OpencodeClient(runtime).getDefaultModel(session?.location?.directory)
        if (!cancelled) setDefaultModel(model)
      } catch {
        if (!cancelled) setDefaultModel(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [catalogRevision, hostId, ready, session?.location?.directory])

  useEffect(() => {
    const next = typeof params.session === "string" ? params.session : undefined
    if (next && next !== sessionIdRef.current) setSessionId(next)
  }, [params.session])

  useEffect(() => {
    setVoiceOverride(undefined)
    setSelectedSkills([])
    const cached = sessionId ? readSessionDraft(hostId, sessionId) : ""
    setDraftSelection({ start: cached.length, end: cached.length })
    void loadSessionVoiceEngine(sessionId ?? "").then(setVoiceOverride).catch(() => undefined)
  }, [hostId, sessionId])

  useEffect(() => {
    if (!sessionId || !ready) {
      setCommands([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const runtime = await ensureConnection(hostId)
        const list = await new OpencodeClient(runtime).listCommands(session?.location?.directory)
        if (!cancelled) setCommands(list)
      } catch {
        if (!cancelled) setCommands([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [catalogRevision, hostId, ready, session?.location?.directory, sessionId])

  useEffect(() => {
    void listMobileModels()
      .then((items) => setPhoneModelReady(items.some((item) => item.installed)))
      .catch(() => setPhoneModelReady(false))
  }, [])

  // Host runtime: the phone needs the browse root and whether opencode is up.
  // It is asked whenever the transport becomes ready, because opencode can be
  // restarted (or started late) while the host itself stays up.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void (async () => {
      try {
        const runtime = await ensureConnection(hostId)
        const info = await new OpencodeClient(runtime).hostRuntime()
        if (cancelled) return
        setOpencodeOnline(info.opencode.available)
        setOpencodeError(info.opencode.error ?? null)
      } catch {
        // Older hosts have no /host/runtime; fall back to the handshake state.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hostId, ready])

  // Mirror the opencode availability announced by the host handshake and by
  // the `opencode.state` push. This is what separates "host offline" from
  // "host online, opencode not started".
  const handshakeOpencode = connection?.session?.opencode
  useEffect(() => {
    if (!handshakeOpencode) return
    if (typeof handshakeOpencode.available === "boolean") setOpencodeOnline(handshakeOpencode.available)
    setOpencodeError(handshakeOpencode.error ?? null)
  }, [handshakeOpencode])

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
      setDraft((current) => appendVoiceText(current, text))
    },
    { ...(hostTranscribe ? { hostTranscribe } : {}), ...(voiceOverride ? { preference: voiceOverride } : {}) },
  )

  const openVoicePanel = () => {
    if (voiceStage !== "closed" || !ready || readOnly || dictation.transcribing) return
    Keyboard.dismiss()
    setVoiceStage("recording")
    void dictation.start("zh-CN")
  }

  const stopVoiceCapture = () => {
    if (voiceStage !== "recording") return
    dictation.pause()
    setVoiceStage("confirm")
  }

  const confirmVoice = () => {
    setVoiceStage("closed")
    dictation.confirm()
  }

  const cancelVoice = () => {
    setVoiceStage("closed")
    dictation.cancel()
  }

  useEffect(() => {
    setVoiceStage("closed")
    dictation.cancel()
    // Only discard when the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(
    () => () => {
      dictation.cancel()
    },
    // The cancel callbacks are stable; avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const notify = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 3_000)
  }, [])

  const streamRef = useRef(new SessionStreamController())

  useEffect(() => {
    streamRef.current.setSession(undefined)
    setLiveState(sessionId ? { sessionId, messages: [] } : { messages: [] })
    if (!ready || !sessionId) return
    streamRef.current.setSession(sessionId)
    // The frame timer only runs while the controller has something to
    // animate. Before this it ticked at 30 fps for the whole session, which
    // kept the phone awake while a turn was idle.
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }
    const tick = () => {
      const controller = streamRef.current
      if (controller.pump()) {
        setLiveState({ sessionId, messages: controller.snapshot() })
      }
      if (!controller.hasWork()) stop()
    }
    const start = () => {
      if (timer) return
      timer = setInterval(tick, STREAM_FRAME_MS)
    }
    streamStartRef.current = start
    start()
    return () => {
      stop()
      streamStartRef.current = undefined
      streamRef.current.setSession(undefined)
    }
  }, [ready, sessionId])

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    [],
  )

  const refreshTranscript = useCallback(async (id: string, client: OpencodeClient) => {
    const revision = ++transcriptRevision.current
    const isCurrent = () => sessionIdRef.current === id && transcriptRevision.current === revision
    const cached = messagesSessionIdRef.current === id ? messagesRef.current : null
    try {
      const result = await reconcileTranscript(
        (cursor) => client.listMessages(id, cursor ? { cursor } : { limit: 60, order: "desc" }),
        { messages: cached ?? [], olderCursor: cached ? olderCursorRef.current : undefined },
      )
      if (!isCurrent()) return
      messagesSessionIdRef.current = id
      messagesRef.current = result.messages
      olderCursorRef.current = result.olderCursor
      setMessages(result.messages)
      setOlderCursor(result.olderCursor)
      setHistorySyncError(false)
    } catch (cause) {
      if (isCurrent()) setHistorySyncError(true)
      throw cause
    }
  }, [])

  const refreshActivities = useCallback(async (id: string, client: OpencodeClient, directory?: string) => {
    await Promise.allSettled([
      client.listRunningJobs(id).then((jobs) => {
        if (sessionIdRef.current === id) setJobState({ id, jobs })
      }),
      directory && client.listRunningShells(directory).then((shells) => {
        if (sessionIdRef.current === id) setShellState({ id, ids: new Set(shells.map((shell) => shell.id)) })
      }),
    ])
  }, [])

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
        const [detail, , pendingPermissions, pendingForms, queued, childPage] = await Promise.all([
          client.getSession(id),
          refreshTranscript(id, client).catch(() => undefined),
          client.listPermissions(id).catch(() => undefined),
          client.listForms(id).catch(() => undefined),
          client.listInbox(id).catch(() => undefined),
          client.listSessions({ parentID: id, limit: 50, order: "desc" }).catch(() => undefined),
        ])
        if (sessionIdRef.current !== id) return
        messagesSessionIdRef.current = id
        setSession(detail)
        if (pendingPermissions) setPermissions(pendingPermissions)
        if (pendingForms) setForms(pendingForms)
        if (queued) setInbox(queueOnly(queued))
        if (childPage) setChildren(childPage.data)
        void refreshActivities(id, client, detail.location?.directory)
      } catch (cause) {
        if (sessionIdRef.current !== id) return
        setError(describeError(cause, t))
      } finally {
        if (sessionIdRef.current === id) setLoadingSession(false)
      }
    },
    [hostId, refreshActivities, refreshTranscript, t],
  )

  const applyCachedSession = useCallback((cached: SessionSnapshot) => {
    setSession(cached.session)
    messagesRef.current = cached.messages
    olderCursorRef.current = cached.olderCursor
    setMessages(cached.messages)
    setOlderCursor(cached.olderCursor)
    setInbox(cached.inbox)
    setChildren(cached.children)
    setPermissions(cached.permissions)
    setForms(cached.forms)
    setLoadingSession(false)
    setError(null)
    restoreOffsetRef.current = cached.offset > 0 ? cached.offset : undefined
  }, [])

  const cacheCurrentSession = useCallback(() => {
    if (!sessionId || session?.id !== sessionId || !messagesForSession) return
    writeSessionCache(hostId, sessionId, {
      session,
      messages: messagesForSession,
      ...(olderCursor ? { olderCursor } : {}),
      inbox,
      children,
      permissions,
      forms,
      offset: messageOffsetRef.current,
    })
  }, [children, forms, hostId, inbox, messagesForSession, olderCursor, permissions, session, sessionId])

  useEffect(() => {
    cacheCurrentSession()
  }, [cacheCurrentSession])

  useEffect(() => {
    transcriptRevision.current += 1
    setHistorySyncError(false)
    if (!sessionId) {
      messagesSessionIdRef.current = undefined
      setSession(null)
      setMessages(null)
      setChildren([])
      setInbox([])
      setPermissions([])
      setForms([])
      setOlderCursor(undefined)
      setLoadingSession(false)
      restoreOffsetRef.current = undefined
      return
    }
    const cached = readSessionCache(hostId, sessionId)
    if (cached) {
      messagesSessionIdRef.current = sessionId
      applyCachedSession(cached)
      void loadSession(sessionId)
      return
    }
    messagesSessionIdRef.current = sessionId
    messagesRef.current = null
    olderCursorRef.current = undefined
    setSession(null)
    setMessages(null)
    setOlderCursor(undefined)
    setInbox([])
    setChildren([])
    setPermissions([])
    setForms([])
    setLoadingSession(true)
    restoreOffsetRef.current = undefined
    void loadSession(sessionId, { initial: true })
  }, [applyCachedSession, hostId, loadSession, sessionId])

  const sessionDirectoryRef = useRef(session?.location?.directory)
  sessionDirectoryRef.current = session?.location?.directory

  const refreshFromEvents = useCallback(
    async (id: string, kinds: Set<SessionRefreshKind>) => {
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
                if (sessionIdRef.current === id) setInbox(queueOnly(items))
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
          tasks.push(refreshTranscript(id, client))
        }
        if (kinds.has("activity")) tasks.push(refreshActivities(id, client, sessionDirectoryRef.current))
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
    [hostId, refreshActivities, refreshTranscript],
  )

  useEffect(() => {
    if (!ready || !hostId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const pendingKinds = new Set<SessionRefreshKind>()
    let pendingSession: string | undefined
    let refreshing = false
    let disposed = false
    const scheduleRefresh = () => {
      if (disposed || timer || refreshing || pendingKinds.size === 0) return
      timer = setTimeout(() => {
        timer = undefined
        const id = pendingSession
        const kinds = new Set(pendingKinds)
        pendingKinds.clear()
        if (!id || sessionIdRef.current !== id) return
        refreshing = true
        void refreshFromEvents(id, kinds).finally(() => {
          refreshing = false
          scheduleRefresh()
        })
      }, 180)
    }
    const enqueueRefresh = (id: string, kinds: SessionRefreshKind[]) => {
      if (pendingSession !== id) pendingKinds.clear()
      pendingSession = id
      for (const kind of kinds) pendingKinds.add(kind)
      scheduleRefresh()
    }
    const unsubscribe = subscribeHostEvents(hostId, (event) => {
      const type = event.type
      if (!type) return

      if (type === "server.connected") {
        // The SSE stream reconnects silently after a network change. Pull the
        // current state once so events missed while offline are not lost.
        invalidateSessionIndex(hostId)
        setCatalogRevision((value) => value + 1)
        const id = sessionIdRef.current
        if (id) enqueueRefresh(id, sessionRefreshKinds(type))
        return
      }

      if (type === "session.deleted") {
        const deletedId = eventSessionID(event)
        invalidateSessionIndex(hostId)
        if (deletedId && deletedId === sessionIdRef.current) {
          deleteSessionCache(hostId, deletedId)
          clearSessionDraft(hostId, deletedId)
          setLiveState({ messages: [] })
          setSessionId(undefined)
          setSession(null)
          setMessages(null)
          setChildren([])
          setInbox([])
          setPermissions([])
          setForms([])
          setOlderCursor(undefined)
          setError(null)
          streamRef.current.setSession(undefined)
          void clearLastSession(hostId)
          router.setParams({ session: "" })
          notify(t("sessionDeleted"))
        }
        return
      }

      if (type === "config.updated" || type.startsWith("mcp.")) {
        setCatalogRevision((value) => value + 1)
        if (type === "config.updated") invalidateSessionIndex(hostId)
        return
      }

      if (/^session\.(?:created|renamed|archived|unarchived|moved|forked)$/u.test(type)) {
        invalidateSessionIndex(hostId)
      }

      const id = sessionIdRef.current
      if (!id) return
      const eventSession = eventSessionID(event)
      if (eventSession && eventSession !== id) {
        if (
          type === "session.created" ||
          (/^session\.(?:execution\.|idle$)/u.test(type) && childrenRef.current.some((child) => child.id === eventSession))
        ) {
          enqueueRefresh(id, ["session", "activity"])
        }
        return
      }

      const controller = streamRef.current
      controller.ingest(event)
      if (controller.hasWork()) streamStartRef.current?.()
      enqueueRefresh(id, sessionRefreshKinds(type))
    })
    return () => {
      disposed = true
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [hostId, notify, ready, refreshFromEvents, t])

  const loadOlder = async () => {
    if (!sessionId || !olderCursor || loadingOlderRef.current) return
    const id = sessionId
    const revision = transcriptRevision.current
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const runtime = await ensureConnection(hostId)
      const page = await new OpencodeClient(runtime).listMessages(id, { cursor: olderCursor })
      if (sessionIdRef.current !== id || transcriptRevision.current !== revision) return
      const merged = mergeMessages(page.data, messagesRef.current ?? [])
      messagesRef.current = merged
      olderCursorRef.current = page.cursor?.next
      setMessages(merged)
      setOlderCursor(page.cursor?.next)
    } catch (cause) {
      if (sessionIdRef.current === id) setError(describeError(cause, t))
    } finally {
      loadingOlderRef.current = false
      setLoadingOlder(false)
    }
  }

  olderCursorRef.current = olderCursor
  loadOlderRef.current = () => void loadOlder()

  const onViewableItemsChanged = useRef(
    (info: { viewableItems: Array<{ item: SessionMessage }> }) => {
      const oldest = oldestMessageIdRef.current
      if (!oldest || !olderCursorRef.current || loadingOlderRef.current) return
      if (info.viewableItems.some((entry) => entry.item.id === oldest)) loadOlderRef.current()
    },
  ).current
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current

  // Following is derived from the resting offset. `onScroll` is throttled, so
  // the final frame of a drag or a jump can be dropped; recompute on the stop
  // events as well instead of trusting the last emitted sample.
  const applyScrollState = (y: number) => {
    // Follow only at the very bottom. As soon as the user scrolls back, new
    // streamed output must not drag the visible history around.
    const nextFollowing = shouldFollow(y)
    // A programmatic jump animates through the middle of the list, where the
    // offset still looks "scrolled back". Ignore those frames so the button
    // does not reappear under the finger that just pressed it.
    if (jumpingRef.current) {
      if (!nextFollowing) return
      jumpingRef.current = false
    }
    if (nextFollowing !== followingRef.current) {
      followingRef.current = nextFollowing
      setFollowing(nextFollowing)
      if (nextFollowing) {
        // Back at the newest end: everything is seen, and the jump animation
        // must not re-light the dot with the offset captured mid-flight.
        lastSeenNewestRef.current = newestMessageRef.current
        setHasNewContent(false)
      } else {
        // Leaving the bottom arms the marker with what is currently visible.
        lastSeenNewestRef.current = newestMessageRef.current
        setHasNewContent(false)
      }
    }
    setShowJump(!nextFollowing && y > 240)
  }

  const handleMessageScroll = (event: {
    nativeEvent: {
      contentOffset: { y: number }
      contentSize: { height: number }
      layoutMeasurement: { height: number }
    }
  }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    messageOffsetRef.current = contentOffset.y
    if (sessionId) updateSessionOffset(hostId, sessionId, contentOffset.y)
    applyScrollState(contentOffset.y)
    // Inverted list: scrolling towards older messages increases contentOffset.y.
    // Start fetching before the user actually hits the very top.
    const distanceToOldest = contentSize.height - (contentOffset.y + layoutMeasurement.height)
    if (distanceToOldest < 420) void loadOlder()
  }

  const handleMessageScrollSettled = () => {
    applyScrollState(messageOffsetRef.current)
  }

  /**
   * A user drag interrupts a running jump animation. Without clearing the
   * jump flag the very stable "tap jump, immediately swipe up" repro left the
   * flag stuck forever and every later scroll frame was ignored, so the
   * jump-to-bottom button never appeared again.
   */
  const handleScrollDragStart = () => {
    if (jumpingRef.current) {
      jumpingRef.current = false
      requestAnimationFrame(() => applyScrollState(messageOffsetRef.current))
    }
  }

  /**
   * Streamed growth at the newest end is anchored natively via
   * `maintainVisibleContentPosition`, so no JS-side offset compensation runs
   * here. The two mechanisms would fight: the native anchor holds the visible
   * text in place, then a manual scrollToOffset would shift it again, which is
   * exactly the residual bounce reported while reading history.
   */
  const handleContentSizeChange = () => {
    const restore = restoreOffsetRef.current
    if (restore !== undefined) {
      restoreOffsetRef.current = undefined
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: restore, animated: false })
      })
    }
  }

  const jumpToBottom = useCallback(() => {
    jumpingRef.current = true
    followingRef.current = true
    setFollowing(true)
    setShowJump(false)
    lastSeenNewestRef.current = newestMessageRef.current
    setHasNewContent(false)
    messageOffsetRef.current = 0
    if (sessionId) updateSessionOffset(hostId, sessionId, 0)
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [hostId, sessionId])

  const selectSession = (id: string) => {
    cacheCurrentSession()
    streamRef.current.setSession(undefined)
    setLiveState({ sessionId: id, messages: [] })
    const cached = readSessionCache(hostId, id)
    messagesSessionIdRef.current = id
    if (cached) {
      applyCachedSession(cached)
    } else {
      setSession(null)
      setMessages(null)
      setOlderCursor(undefined)
      setInbox([])
      setChildren([])
      setPermissions([])
      setForms([])
      setError(null)
      setLoadingSession(true)
      restoreOffsetRef.current = undefined
    }
    setSessionId(id)
    router.setParams({ session: id })
    void saveLastSession(hostId, id)
  }

  const restoredSession = useRef(false)
  useEffect(() => {
    if (restoredSession.current || params.session || params.new === "1" || !ready || !hydrated || opencodeOnline === false) return
    let cancelled = false
    void (async () => {
      const last = await loadLastSession(hostId)
      if (cancelled || sessionIdRef.current) return
      if (!last) {
        restoredSession.current = true
        return
      }
      try {
        const runtime = await ensureConnection(hostId)
        await new OpencodeClient(runtime).getSession(last)
        if (cancelled || sessionIdRef.current) return
        restoredSession.current = true
        setSessionId(last)
        router.setParams({ session: last })
      } catch (cause) {
        if (cancelled) return
        // The remembered session no longer exists: fall back to the blank
        // session screen and forget it. A network/opencode failure must not
        // discard the memory, otherwise a momentarily stopped opencode would
        // reset the user's last session.
        if (isMissingSession(cause)) {
          restoredSession.current = true
          await clearLastSession(hostId)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hostId, hydrated, opencodeOnline, params.new, params.session, ready])

  /** Loads one directory level from the host. Works while opencode is down. */
  const loadTreeListing = useCallback(
    async (path: string) => {
      if (treeListings[path]) return
      setTreeLoading((current) => ({ ...current, [path]: true }))
      try {
        const runtime = await ensureConnection(hostId)
        const listing = await new OpencodeClient(runtime).listDirectories(path)
        setTreeListings((current) => ({ ...current, [path]: listing }))
        setDirHome(listing.home)
      } catch (cause) {
        setDirectoryError(describeError(cause, t))
      } finally {
        setTreeLoading((current) => ({ ...current, [path]: false }))
      }
    },
    [hostId, t, treeListings],
  )

  const toggleDir = useCallback(
    (path: string) => {
      if (expandedDirs.includes(path)) {
        setExpandedDirs((current) => current.filter((item) => item !== path))
        return
      }
      void loadTreeListing(path)
      setExpandedDirs((current) => (current.includes(path) ? current : [...current, path]))
    },
    [expandedDirs, loadTreeListing],
  )

  const openProjectPicker = useCallback(async () => {
    setProjectOpen(true)
    setProjectError(null)
    setDirectoryError(null)
    setDirectoryCheck(null)
    setDirectoryInput("")
    setExpandedDirs([])
    setDirectoryTreeOpen(false)
    setTreeListings({})
    setTreeLoading({})
    try {
      const runtime = await ensureConnection(hostId)
      const info = await new OpencodeClient(runtime).hostRuntime()
      setDirHome(info.home)
    } catch {
      // The tree falls back to the localized placeholder until a listing
      // reports the real home.
    }
    if (projects) return
    try {
      const runtime = await ensureConnection(hostId)
      setProjects(await new OpencodeClient(runtime).listProjects())
    } catch (cause) {
      setProjectError(describeError(cause, t))
    }
  }, [hostId, projects, t])

  // Debounced check so typing a path tells the user whether it exists without
  // creating anything. Typed text is resolved under the home directory (the
  // locked "~" prefix); a pasted absolute path is passed through as-is.
  useEffect(() => {
    if (!projectOpen) return
    const value = directoryInput.trim()
    if (!value) {
      setDirectoryCheck(null)
      setDirectoryChecking(false)
      return
    }
    const wire = value.startsWith("/") ? value : `~/${value}`
    let cancelled = false
    setDirectoryCheck(null)
    setDirectoryChecking(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const runtime = await ensureConnection(hostId)
          const result = await new OpencodeClient(runtime).checkDirectory(wire)
          if (!cancelled) setDirectoryCheck(result)
        } catch (cause) {
          if (!cancelled) {
            setDirectoryCheck({
              valid: false,
              directory: false,
              error: describeError(cause, t),
            })
          }
        } finally {
          if (!cancelled) setDirectoryChecking(false)
        }
      })()
    }, 320)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [directoryInput, hostId, projectOpen, t])

  useEffect(() => {
    if (params.new !== "1" || !ready) return
    void openProjectPicker()
  }, [params.new, ready, openProjectPicker])

  const createSessionIn = async (directory: string) => {
    if (creating || !directory.trim()) return
    setCreating(true)
    setProjectError(null)
    setDirectoryError(null)
    try {
      if (opencodeOnline === false) {
        setProjectError(t("opencodeOfflineBody"))
        return
      }
      const runtime = await ensureConnection(hostId)
      const created = await new OpencodeClient(runtime).createSession({ location: { directory } })
      invalidateSessionIndex(hostId)
      setProjectOpen(false)
      setDirectoryInput("")
      selectSession(created.id)
    } catch (cause) {
      setProjectError(describeError(cause, t))
    } finally {
      setCreating(false)
    }
  }

  /**
   * Renders the directory tree depth-first. `path === ""` is the home row:
   * it starts collapsed, and expanding it lists the home directory's children.
   * Every row carries its own plus button so a session can be created in any
   * directory while browsing, not just the one being navigated into.
   */
  const renderDirRows = (path: string, name: string, depth: number): React.ReactNode => {
    const expanded = expandedDirs.includes(path)
    const listing = treeListings[path]
    const loading = treeLoading[path] === true
    const children = expanded ? listing?.entries ?? [] : []
    const row = (
      <View style={[styles.directoryRow, depth > 0 && { marginLeft: depth * 14 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? `${name} ${t("collapseDirectory")}` : `${name} ${t("expandDirectory")}`}
          onPress={() => toggleDir(path)}
          hitSlop={6}
          style={({ pressed }) => [styles.directoryChevron, pressed && { opacity: 0.6 }]}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} color={loading ? colors.faint : colors.muted} />
        </Pressable>
        <Icon name="folder" size={15} color={colors.muted} />
        <Text style={styles.directoryRowText} numberOfLines={1}>
          {name}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("createInDirectory")} ${path || (dirHome ?? "")}`}
          disabled={creating || !opencodeOnline || readOnly || !(path || dirHome)}
          onPress={() => {
            const target = path || dirHome
            if (target) void createSessionIn(target)
          }}
          hitSlop={6}
          style={({ pressed }) => [
            styles.directoryAdd,
            (creating || !opencodeOnline) && { opacity: 0.35 },
            pressed && { opacity: 0.6 },
          ]}
        >
          {creating ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="plus" size={16} color={colors.accent} />}
        </Pressable>
      </View>
    )
    if (!expanded) return row
    return (
      <View key={path || "__home__"}>
        {row}
        {listing === undefined ? (
          loading ? (
            <Text style={[styles.sheetMuted, { marginLeft: (depth + 1) * 14 }]}>{t("loadingDirectory")}</Text>
          ) : null
        ) : children.length === 0 ? (
          <Text style={[styles.sheetMuted, { marginLeft: (depth + 1) * 14 }]}>{t("directoryEmpty")}</Text>
        ) : (
          children.map((entry) => renderDirRows(entry.path, entry.name, depth + 1))
        )}
      </View>
    )
  }

  const loadOptions = useCallback(
    async () => {
      const hasCache = Boolean(agents && models && mcp && skills)
      if (!hasCache) setOptionsBusy(true)
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
        setSelectedSkills((current) =>
          current.filter((selected) => skillList.some((skill) => skill.id === selected.id)),
        )
      } catch (cause) {
        setOptionError(describeError(cause, t))
      } finally {
        setOptionsBusy(false)
      }
    },
    [agents, hostId, mcp, models, session?.location?.directory, skills, t],
  )

  useEffect(() => {
    if (!ready || catalogRevision === 0) return
    void loadOptions()
    // Intentionally keyed only by the catalog revision; loadOptions changes
    // identity whenever its cached data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogRevision, ready])

  // When opencode comes back after being down, resync everything the screen
  // shows: the current transcript, the drawer's session list and the option
  // catalog. Stale "network error" banners from the outage are cleared.
  const wasOffline = useRef(false)
  useEffect(() => {
    if (opencodeOnline !== false) {
      if (opencodeOnline === true && wasOffline.current) {
        wasOffline.current = false
        setError(null)
        if (sessionIdRef.current) void loadSession(sessionIdRef.current)
        invalidateSessionIndex(hostId)
        if (agents !== null || models !== null || mcp !== null || skills !== null) void loadOptions()
      }
      return
    }
    wasOffline.current = true
    // Suppress request errors while the outage lasts: the status bar already
    // explains the state, and stray red text breaks the UI language.
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opencodeOnline, hostId])

  const refreshMcp = useCallback(async () => {
    try {
      const runtime = await ensureConnection(hostId)
      setMcp(await new OpencodeClient(runtime).listMcp(session?.location?.directory))
    } catch (cause) {
      setOptionError(describeError(cause, t))
    }
  }, [hostId, session?.location?.directory, t])

  const openPanel = () => {
    setPanelMode("main")
    setPanelOpen(true)
    void loadOptions()
  }

  const openPanelMode = (mode: PanelMode) => {
    setPanelMode(mode)
    setPanelOpen(true)
    if (mode !== "voice" && mode !== "status" && mode !== "help") void loadOptions()
  }

  useEffect(() => {
    if (!panelOpen) return
    panelFade.setValue(0)
    panelShift.setValue(10)
    Animated.parallel([
      Animated.timing(panelFade, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(panelShift, {
        toValue: 0,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start()
  }, [panelFade, panelMode, panelOpen, panelShift])

  const selectAgent = async (agentId: string) => {
    if (!sessionId) return
    setOptionsBusy(true)
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).switchAgent(sessionId, agentId)
      setSession((current) => (current ? { ...current, agent: agentId } : current))
    } catch (cause) {
      setOptionError(describeError(cause, t))
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
      setOptionError(describeError(cause, t))
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
      setOptionError(describeError(cause, t))
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
      setOptionError(describeError(cause, t))
    } finally {
      setOptionsBusy(false)
    }
  }

  const chooseVoice = async (value: VoiceEnginePreference) => {
    setVoiceOverride(value)
    if (sessionId) await saveSessionVoiceEngine(sessionId, value).catch(() => undefined)
  }

  const sessionBusyNow = session ? sessionBusy(session) : false
  const shellIds = shellState?.id === sessionId ? shellState?.ids : undefined
  const jobs = jobState?.id === sessionId ? jobState?.jobs : undefined
  const activities = useMemo(
    () =>
      session
        ? runningActivities(messagesForSession ?? [], children, { busy: sessionBusyNow, runningShellIds: shellIds, jobs })
        : [],
    [children, jobs, messagesForSession, session, sessionBusyNow, shellIds],
  )
  // A background task keeps the header busy, but the session's own turn is the
  // only thing the main stop button should act on.
  const agentWorking = sessionBusyNow || children.some(sessionBusy)
  const active = ready && opencodeOnline !== false && (agentWorking || activities.length > 0)
  const runningTargets = [
    ...(sessionBusyNow && sessionId ? [sessionId] : []),
    ...children.filter((child) => sessionBusy(child) && !jobs?.some((job) => job.childSessionID === child.id)).map((child) => child.id),
  ]
  const cancellable = activities.filter((activity) =>
    activity.kind === "job" || (activity.kind === "shell" && activity.shellId && session?.location?.directory),
  )
  const canStop = ready && opencodeOnline !== false && !readOnly && !stopping
  const showStop = runningTargets.length > 0 || cancellable.length > 0

  const send = async () => {
    const text = draft.trim()
    const reviewPrompt =
      stagedComments.length > 0
        ? buildReviewPrompt(
            stagedReview?.directory || session?.location?.directory || "",
            stagedComments,
          )
        : null
    if ((!text && !reviewPrompt) || sending || !sessionId || !ready || readOnly) return
    const targetSessionId = sessionId
    setSending(true)
    setError(null)
    setDraftFor(targetSessionId, "")
    try {
      const runtime = await ensureConnection(hostId)
      const client = new OpencodeClient(runtime)
      // Slash commands and shell shortcuts only apply to a plain message. When
      // review comments are staged, the typed text belongs to that review turn.
      if (!reviewPrompt && text.startsWith("!")) {
        const command = text.slice(1).trim()
        if (!command) return
        await client.runShell(targetSessionId, command)
        setTimeout(() => void loadSession(targetSessionId), 350)
        return
      }
      if (!reviewPrompt && text.startsWith("/")) {
        const match = /^\/([^\s]+)\s*([\s\S]*)$/u.exec(text)
        if (!match) return
        const name = match[1] as string
        const args = (match[2] ?? "").trim()
        const key = name.toLowerCase()
        const core = findCoreCommand(key)
        if (core) {
          runCoreCommand(core.action)
          return
        }
        if (commands.some((command) => command.name === name)) {
          await client.runCommand(targetSessionId, name, args)
          setTimeout(() => void loadSession(targetSessionId), 350)
          return
        }
        setDraftFor(targetSessionId, text)
        notify(
          isUnavailableCommand(key)
            ? t("commandUnsupported", { name })
            : t("commandUnknown", { name }),
        )
        return
      }
      // Comments first, then the text the user typed in the session composer.
      const finalReview = reviewPrompt ? appendReviewText(reviewPrompt, text) : null
      const promptText = finalReview ? finalReview.text : text
      const queued = sessionBusyNow
      const optimistic: SessionMessage | null = queued
        ? null
        : { id: `local_${Date.now()}`, type: "user", text: promptText, time: { created: Date.now() } }
      if (optimistic) setMessages((current) => [...(current ?? []), optimistic])
      await client.prompt(targetSessionId, {
        ...(finalReview ?? { text: promptText }),
        ...(queued ? { delivery: "queue" as const } : {}),
        ...(selectedSkills.length > 0
          ? { skills: selectedSkills.map((skill) => ({ id: skill.id })) }
          : {}),
      })
      if (reviewPrompt) clearStagedComments(targetSessionId)
      setSelectedSkills([])
      if (queued) notify(t("sessionQueueing"))
      await loadSession(targetSessionId)
    } catch (cause) {
      setError(describeError(cause, t))
      setDraftFor(targetSessionId, text)
    } finally {
      setSending(false)
    }
  }

  const stopTasks = async (targets: string[], tasks: RunningActivity[]) => {
    if (!sessionId || !canStop) return
    const id = sessionId
    const directory = session?.location?.directory
    setStopping(true)
    try {
      const client = new OpencodeClient(await ensureConnection(hostId))
      // A background subagent is stopped through its job. Other active
      // sessions, including ordinary children, use the interrupt endpoint.
      const results = await Promise.allSettled([
        ...targets.map((target) => client.interrupt(target)),
        ...tasks.flatMap((activity) => {
          if (activity.kind === "job") return [client.cancelJob(activity.jobId)]
          if (activity.kind === "shell" && activity.shellId && directory) {
            return [client.stopShell(activity.shellId, directory)]
          }
          return []
        }),
      ])
      if (sessionIdRef.current !== id) return
      await loadSession(id)
      const failure = results.find((result) => result.status === "rejected")
      if (failure) notify(describeError(failure.reason, t))
    } catch (cause) {
      notify(describeError(cause, t))
    } finally {
      setStopping(false)
    }
  }

  const confirmStop = () => {
    if (!showStop || !canStop) return
    Alert.alert(t("stopTaskTitle"), t("stopTaskBody"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("stop"), style: "destructive", onPress: () => void stopTasks(runningTargets, cancellable) },
    ])
  }

  const stopActivity = (activity: RunningActivity) => {
    if (activity.kind === "job" || activity.kind === "shell") {
      void stopTasks([], [activity])
    } else if (activity.kind === "subagent") {
      void stopTasks([activity.sessionId], [])
    } else if (sessionId) {
      Alert.alert(t("stopTaskTitle"), t("stopToolBody"), [
        { text: t("cancel"), style: "cancel" },
        { text: t("stop"), style: "destructive", onPress: () => void stopTasks([sessionId], []) },
      ])
    }
  }

  const compactContext = () => {
    if (!sessionId) return
    void ensureConnection(hostId)
      .then((runtime) => new OpencodeClient(runtime).compactSession(sessionId))
      .then(() => loadSession(sessionId))
      .catch((cause: unknown) => setError(describeError(cause, t)))
  }

  const toggleSkill = (skill: SkillInfo) => {
    setSelectedSkills((current) =>
      current.some((selected) => selected.id === skill.id)
        ? current.filter((selected) => selected.id !== skill.id)
        : [...current, { id: skill.id, name: skill.name }],
    )
  }

  const runCoreCommand = (action: CoreCommandAction) => {
    setDraft("")
    const leavePanel = (run: () => void) => {
      if (!panelOpen) {
        run()
        return
      }
      setPanelOpen(false)
      setTimeout(run, 240)
    }
    switch (action) {
      case "models":
        openPanelMode("model")
        return
      case "agents":
        openPanelMode("agent")
        return
      case "mcps":
        openPanelMode("mcp")
        return
      case "skills":
        openPanelMode("skill")
        return
      case "variants":
        openPanelMode("variant")
        return
      case "status":
        openPanelMode("status")
        return
      case "help":
        openPanelMode("help")
        return
      case "sessions":
        leavePanel(openDrawer)
        return
      case "new":
        leavePanel(() => void openProjectPicker())
        return
      case "compact":
        leavePanel(compactContext)
        return
      case "diff":
        leavePanel(() => {
          if (!sessionId) return
          router.push({
            pathname: "/hosts/[hostId]/sessions/[sessionId]/diff",
            params: { hostId, sessionId },
          })
        })
        return
      case "stop":
        confirmStop()
        return
    }
  }

  const serverCommandNames = new Set(commands.map((command) => command.name))
  const commandChoices: CommandChoice[] = [
    ...CORE_COMMANDS.map<CommandChoice>((command) => ({
      name: command.name,
      aliases: command.aliases,
      description: t(command.descriptionKey),
      category: command.category,
      enabled: true,
      run: () => runCoreCommand(command.action),
    })),
    ...commands
      .filter((command) => !findCoreCommand(command.name))
      .map<CommandChoice>((command) => ({
        name: command.name,
        aliases: [],
        description: command.description ?? t("command"),
        category: "server",
        enabled: true,
        run: () => {
          const fill = () => {
            setDraft(`/${command.name} `)
            inputRef.current?.focus()
          }
          if (!panelOpen) {
            fill()
            return
          }
          setPanelOpen(false)
          setTimeout(fill, 240)
        },
      })),
    ...UNAVAILABLE_COMMANDS.filter(
      (name) => !findCoreCommand(name) && !serverCommandNames.has(name),
    ).map<CommandChoice>((name) => ({
      name,
      aliases: [],
      description: t("commandUnavailable"),
      category: "unavailable",
      enabled: false,
      run: () => notify(t("commandUnsupported", { name })),
    })),
  ]

  const commandGroups = (
    [
      ["session", t("commandCategorySession")],
      ["agent", t("commandCategoryAgent")],
      ["system", t("commandCategorySystem")],
      ["server", t("commandCategoryServer")],
      ["unavailable", t("commandCategoryUnavailable")],
    ] as const
  )
    .map(([category, label]) => ({
      category,
      label,
      commands: commandChoices.filter((command) => command.category === category),
    }))
    .filter((group) => group.commands.length > 0)

  const cancelQueued = async (item: InboxItem) => {
    if (!sessionId) return
    try {
      const runtime = await ensureConnection(hostId)
      await new OpencodeClient(runtime).cancelInbox(sessionId, item.id)
      setInbox((current) => current.filter((entry) => entry.id !== item.id))
    } catch (cause) {
      setError(describeError(cause, t))
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
      setError(describeError(cause, t))
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
      setError(describeError(cause, t))
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
      setError(describeError(cause, t))
    } finally {
      setDockBusy(false)
    }
  }

  const displayMessages = useMemo(() => {
    const server = messagesSessionIdRef.current === sessionId ? (messages ?? []) : []
    const liveById = new Map(liveMessages.map((message) => [message.id, message]))
    const combined = server.map((message) => {
      const live = liveById.get(message.id)
      if (!live) return message
      liveById.delete(message.id)
      // While the presentation queue is active, keep typing against the live
      // snapshot; the completed server message is only a fallback.
      return messageWeight(live) > 0 ? live : message
    })
    return mergeAssistantRuns([...combined, ...liveById.values()]).reverse()
  }, [liveMessages, messages, sessionId])
  oldestMessageIdRef.current = displayMessages[displayMessages.length - 1]?.id
  newestMessageRef.current = displayMessages[0]
  useEffect(() => {
    if (followingRef.current) {
      lastSeenNewestRef.current = newestMessageRef.current
      setHasNewContent(false)
      return
    }
    const newest = newestMessageRef.current
    const seen = lastSeenNewestRef.current
    if (newest && (newest.id !== seen?.id || messageWeight(newest) > messageWeight(seen))) {
      setHasNewContent(true)
    }
  }, [displayMessages, sessionId])
  const currentModel = useMemo(() => {
    const modelId = session?.model?.id ?? defaultModel?.modelID
    const providerId = session?.model?.providerID ?? defaultModel?.providerID
    return (
      models?.find((model) => model.modelID === modelId && model.providerID === providerId) ??
      (defaultModel?.modelID === modelId && defaultModel?.providerID === providerId ? defaultModel : undefined)
    )
  }, [defaultModel, models, session?.model?.id, session?.model?.providerID])
  const usage = useMemo(
    () => contextUsage(messagesForSession ?? [], currentModel ?? undefined),
    [currentModel, messagesForSession],
  )
  const displayAgents = useMemo(() => visiblePrimaryAgents(agents ?? []), [agents])
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
  const defaultAgent = displayAgents.find((agent) => agent.id === "build") ?? displayAgents[0]
  const activeAgentId = session?.agent ?? defaultAgent?.id
  const agentName =
    displayAgents.find((agent) => agent.id === activeAgentId)?.name ?? activeAgentId ?? "build"
  const modelName = currentModel?.name ?? defaultModel?.name ?? session?.model?.id ?? models?.[0]?.name ?? "—"
  const variantName = session?.model?.variant ?? t("reasoningStandard")
  const contextTokens = usage ? formatTokens(usage.tokens) : t("noContext")
  const statusParts = [
    { text: agentName },
    { text: modelName },
    { text: variantName },
    { text: contextTokens },
    ...(usage?.percent !== undefined
      ? [{ text: `${usage.percent}%`, danger: usage.percent >= 80, strong: true }]
      : []),
  ]
  const commandQuery =
    draft.startsWith("/") &&
    !draft.includes(" ") &&
    !draft.includes("\n") &&
    draftSelection.start === draft.length &&
    draftSelection.end === draft.length
      ? draft.slice(1)
      : null
  const commandMatches =
    commandQuery === null
      ? []
      : commandChoices.filter((command) => {
          const query = commandQuery.toLowerCase()
          return (
            command.name.toLowerCase().startsWith(query) ||
            command.aliases.some((alias) => alias.toLowerCase().startsWith(query))
          )
        })

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
      // Android already resizes the window for the keyboard (adjustResize);
      // adding "height" here compensates twice and lifts the whole session
      // screen whenever a sheet input opens the keyboard.
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
      {...drawerSwipe.panHandlers}
    >
      <View style={styles.header}>
        <IconButton label={t("sessions")} onPress={openDrawer}>
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
            disabled={!sessionId || opencodeOnline === false}
            onPress={() =>
              sessionId && opencodeOnline !== false
                ? router.push({
                    pathname: "/hosts/[hostId]/sessions/[sessionId]/review",
                    params: { hostId, sessionId, directory: session?.location?.directory ?? "" },
                  })
                : undefined
            }
          >
            <Icon name="edit" size={20} color={sessionId && opencodeOnline !== false ? colors.muted : colors.faint} />
          </IconButton>
          <IconButton
            label={t("diff")}
            disabled={!sessionId || opencodeOnline === false}
            onPress={() =>
              sessionId && opencodeOnline !== false
                ? router.push({
                    pathname: "/hosts/[hostId]/sessions/[sessionId]/diff",
                    params: { hostId, sessionId },
                  })
                : undefined
            }
          >
            <Icon name="diff" size={20} color={sessionId && opencodeOnline !== false ? colors.muted : colors.faint} />
          </IconButton>
        </View>
      </View>

      {dropped ? (
        <View style={[styles.opencodeBar, { borderTopWidth: StyleSheet.hairlineWidth }]}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.opencodeBarText} numberOfLines={1}>
            {t("reconnectingBanner")}
          </Text>
        </View>
      ) : null}

      {opencodeOnline === false ? (
        <View style={styles.opencodeBar}>
          <Icon name="server" size={14} color={colors.warning} />
          <Text style={styles.opencodeBarText} numberOfLines={2}>
            {t("opencodeOffline")}
            {opencodeError ? ` · ${opencodeError}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
            onPress={() => {
              void (async () => {
                try {
                  const runtime = await ensureConnection(hostId)
                  const info = await new OpencodeClient(runtime).hostRuntime()
                  setOpencodeOnline(info.opencode.available)
                  setOpencodeError(info.opencode.error ?? null)
                  if (info.opencode.available && sessionIdRef.current) {
                    await loadSession(sessionIdRef.current)
                  }
                } catch {
                  // keep the previous state
                }
              })()
            }}
            hitSlop={8}
          >
            <Text style={styles.opencodeBarAction}>{t("retry")}</Text>
          </Pressable>
        </View>
      ) : null}

      {!ready && !dropped ? (
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
          {/* The jump control anchors to this wrapper, not to the whole column:
              anything anchored to the column bottom would sit behind the composer. */}
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
                contentContainerStyle={[
                  styles.messages,
                  // Short conversations anchor to the visual top instead of
                  // clustering at the bottom edge. The list is inverted, so
                  // layout "flex-end" maps to the top of the screen; with
                  // overflowing content flexGrow is a no-op and scrolling
                  // behaves exactly as before.
                  { flexGrow: 1, justifyContent: "flex-end" },
                ]}
                keyboardShouldPersistTaps="handled"
                onEndReached={() => void loadOlder()}
                onEndReachedThreshold={0.4}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig}
                onScroll={handleMessageScroll}
                onScrollBeginDrag={handleScrollDragStart}
                onScrollEndDrag={handleMessageScrollSettled}
                onMomentumScrollEnd={handleMessageScrollSettled}
                scrollEventThrottle={16}
                // Native anchoring: while the user reads history, streamed
                // output growing at the newest end is held in place by the
                // platform instead of a JS-side offset dance, which removes
                // the residual bounce of the manual compensation.
                maintainVisibleContentPosition={{
                  // Index 0 is the newest message; never anchor on it so new
                  // messages inserted above the viewport do not move it.
                  minIndexForVisible: 1,
                  // Near the newest end, follow new output automatically.
                  autoscrollToTopThreshold: 24,
                }}
                // Selecting text focuses the native TextView; without this
                // Android scrolls the transcript on the first selection.
                scrollsChildToFocus={false}
                onContentSizeChange={handleContentSizeChange}
                removeClippedSubviews={false}
                ListFooterComponent={
                  olderCursor ? (
                    <Pressable accessibilityRole="button" onPress={() => void loadOlder()} style={styles.olderButton}>
                      <Text style={styles.olderText}>{loadingOlder ? t("loadingOlder") : t("scrollForOlder")}</Text>
                    </Pressable>
                  ) : (
                    <View style={{ height: 4 }} />
                  )
                }
                ListEmptyComponent={
                  <Text style={styles.emptyMessages}>{t("noMessages")}</Text>
                }
              />
            )}

            {showJump ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("jumpToBottom")}
                onPress={jumpToBottom}
                style={[styles.jump, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <Icon name="chevronDown" size={16} color={colors.muted} />
                {hasNewContent && !following ? <View style={[styles.jumpDot, { backgroundColor: colors.accent }]} /> : null}
              </Pressable>
            ) : null}
          </View>

          {/* Reserve the row height only while something is actually running:
              pill (background tasks) or stop button (active turn). When the
              session is idle the row disappears entirely. */}
          {sessionId && (showStop || activities.length > 0) ? (
            <View style={styles.activitySlot}>
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
              {showStop && !readOnly ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("stopTaskTitle")}
                  disabled={!canStop}
                  accessibilityState={{ disabled: !canStop }}
                  onPress={confirmStop}
                  style={({ pressed }) => [styles.stopTaskButton, pressed && { opacity: 0.72 }]}
                >
                  {/* Outer circle, inner square: the stop glyph stays large
                      inside a smaller circular button. */}
                  <Icon name="stop" size={20} color="#FFFFFF" />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {historySyncError && ready && opencodeOnline !== false && sessionId ? (
            <View style={styles.opencodeBar}>
              <Text style={styles.opencodeBarText}>{t("historySyncFailed")}</Text>
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void loadSession(sessionId)}>
                <Text style={styles.opencodeBarAction}>{t("retry")}</Text>
              </Pressable>
            </View>
          ) : null}
          {error && opencodeOnline !== false ? <Text style={styles.error}>{error}</Text> : null}

          <PendingDock
            permissions={permissions}
            forms={forms}
            busy={dockBusy || readOnly}
            onReplyPermission={(request, decision) => void replyPermission(request, decision)}
            onSubmitForm={(form, answer) => void submitForm(form, answer)}
            onCancelForm={(form) => void cancelForm(form)}
          />

          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {stagedComments.length > 0 ? (
              <View style={styles.reviewStaging}>
                <View style={styles.reviewStagingHead}>
                  <Icon name="edit" size={13} color={colors.accent} />
                  <Text style={styles.reviewStagingTitle}>
                    {t("stagedComments", { n: stagedComments.length })}
                  </Text>
                </View>
                <ScrollView
                  style={styles.reviewCardList}
                  contentContainerStyle={styles.reviewCardListContent}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                >
                  {stagedComments.map((comment, index) => (
                    <View
                      key={`${comment.path}-${comment.selection.startLine}-${comment.selection.endLine}-${index}`}
                      style={styles.reviewCard}
                    >
                      <View style={styles.reviewCardHead}>
                        <Text style={styles.reviewCardPath} numberOfLines={1}>
                          {comment.path}:{comment.selection.startLine}–{comment.selection.endLine}
                        </Text>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={t("deleteComment")}
                          onPress={() => sessionId && removeStagedComment(sessionId, index)}
                          hitSlop={8}
                        >
                          <Icon name="close" size={14} color={colors.faint} />
                        </Pressable>
                      </View>
                      <Text style={styles.reviewCardBody} numberOfLines={3}>
                        {comment.comment}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              </View>
            ) : null}

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

            {voiceStage === "closed" && (dictation.transcribing || dictation.error) ? (
              <View style={styles.voiceBar}>
                {dictation.transcribing ? <ActivityIndicator size="small" color={colors.accent} /> : null}
                <Text style={[styles.voiceText, dictation.error && { color: colors.danger }]} numberOfLines={2}>
                  {dictation.error
                    ? dictation.error
                    : dictation.transcribing
                      ? dictation.engine === "host"
                        ? t("transcribingHost")
                        : dictation.engine === "system"
                          ? t("transcribingSystem")
                          : t("transcribingLocal")
                      : ""}
                </Text>
                {dictation.error ? (
                  <Pressable accessibilityRole="button" onPress={dictation.clearError} hitSlop={8}>
                    <Text style={styles.voiceStop}>{t("close")}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {selectedSkills.length > 0 ? (
              <View style={styles.skillChips}>
                {selectedSkills.map((skill) => (
                  <Pressable
                    key={skill.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${t("remove")} ${skill.name}`}
                    onPress={() =>
                      setSelectedSkills((current) => current.filter((item) => item.id !== skill.id))
                    }
                    style={({ pressed }) => [styles.skillChip, pressed && { opacity: 0.65 }]}
                  >
                    <Icon name="spark" size={11} color={colors.accent} />
                    <Text style={styles.skillChipText} numberOfLines={1}>
                      {skill.name}
                    </Text>
                    <Icon name="close" size={11} color={colors.faint} />
                  </Pressable>
                ))}
              </View>
            ) : null}

            {commandMatches.length > 0 ? (
              <ScrollView
                style={styles.commandPanel}
                contentContainerStyle={{ paddingBottom: 2 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {commandMatches.map((command) => (
                  <Pressable
                    key={command.name}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !command.enabled }}
                    disabled={!command.enabled}
                    onPress={command.run}
                    style={({ pressed }) => [
                      styles.commandRow,
                      pressed && { opacity: 0.65 },
                      !command.enabled && { opacity: 0.4 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.commandName,
                        !command.enabled && { color: colors.faint },
                      ]}
                    >
                      /{command.name}
                    </Text>
                    <Text style={styles.commandDescription} numberOfLines={1}>
                      {command.description}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            {notice ? <Text style={styles.notice}>{notice}</Text> : null}

            <View style={styles.composerRow}>
              <TextInput
                ref={inputRef}
                editable={ready && !sending && !readOnly && voiceStage === "closed" && opencodeOnline !== false}
                multiline
                onChangeText={setDraft}
                onSelectionChange={(event) => setDraftSelection(event.nativeEvent.selection)}
                style={styles.input}
                value={draft}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("dictation")}
                disabled={
                  !ready ||
                  readOnly ||
                  sending ||
                  dictation.transcribing ||
                  !voiceReady ||
                  voiceStage !== "closed" ||
                  opencodeOnline === false
                }
                onPress={openVoicePanel}
                style={({ pressed }) => [
                  styles.iconAction,
                  (!ready || readOnly || sending || !voiceReady || voiceStage !== "closed" || opencodeOnline === false) && { opacity: 0.32 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Icon
                  name="mic"
                  size={19}
                  color={voiceStage === "recording" ? colors.accent : colors.muted}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("send")}
                disabled={
                  !ready ||
                  sending ||
                  readOnly ||
                  voiceStage !== "closed" ||
                  opencodeOnline === false ||
                  (draft.trim().length === 0 && stagedComments.length === 0)
                }
                onPress={() => void send()}
                style={({ pressed }) => [
                  styles.sendButton,
                  { backgroundColor: colors.accent },
                  (!ready ||
                    sending ||
                    readOnly ||
                    voiceStage !== "closed" ||
                    opencodeOnline === false ||
                    (draft.trim().length === 0 && stagedComments.length === 0)) && {
                    opacity: 0.32,
                  },
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

            {voiceStage !== "closed" ? (
              <VoicePanel
                stage={voiceStage}
                error={dictation.error}
                engine={dictation.engine}
                onStop={stopVoiceCapture}
                onConfirm={confirmVoice}
                onCancel={cancelVoice}
              />
            ) : null}

            {voiceStage === "closed" ? (
              <View style={styles.statusBar}>
                <ScrollView
                  horizontal
                  nestedScrollEnabled
                overScrollMode="never"
                showsHorizontalScrollIndicator={false}
                onTouchStart={(event) => {
                  statusGesture.current = {
                    x: event.nativeEvent.pageX,
                    y: event.nativeEvent.pageY,
                    scrolled: false,
                  }
                }}
                onTouchMove={(event) => {
                  const dx = Math.abs(event.nativeEvent.pageX - statusGesture.current.x)
                  const dy = Math.abs(event.nativeEvent.pageY - statusGesture.current.y)
                  if (dx > 8 && dx > dy) statusGesture.current.scrolled = true
                }}
                onTouchEnd={(event) => {
                  const touch = event.nativeEvent.changedTouches?.[0]
                  const dx = touch ? Math.abs(touch.pageX - statusGesture.current.x) : 0
                  const dy = touch ? Math.abs(touch.pageY - statusGesture.current.y) : 0
                  const wasScrolled = statusGesture.current.scrolled || dx > 8 || dy > 8
                  statusGesture.current.scrolled = false
                  // The session-settings panel is opencode-backed; keep it
                  // closed while opencode is down instead of surfacing another
                  // error surface.
                  if (!wasScrolled && opencodeOnline !== false) openPanel()
                }}
                onScrollBeginDrag={() => {
                  statusGesture.current.scrolled = true
                }}
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
              </View>
            ) : null}
          </View>
        </View>
      )}

      <SessionDrawer
        visible={drawerOpen}
        active={foreground && (drawerOpen || drawerDragging)}
        progress={drawerProgress}
        width={drawerWidth}
        hostId={hostId}
        hostName={host.name}
        statusLabel={statusLabel}
        currentSessionId={sessionId}
        opencodeOffline={opencodeOnline === false}
        onClose={closeDrawer}
        onSelect={(next) => selectSession(next.id)}
        onNewSession={() => void openProjectPicker()}
        onSettings={() => router.push({ pathname: "/hosts/[hostId]/edit", params: { hostId } })}
      />

      <BottomSheet
        visible={projectOpen}
        title={t("chooseProject")}
        onClose={() => setProjectOpen(false)}
        height={panelHeight}
      >
        <View style={styles.directoryBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("homeDirectory")}
            accessibilityState={{ expanded: directoryTreeOpen }}
            onPress={() => {
              setDirectoryTreeOpen(!directoryTreeOpen)
              if (!directoryTreeOpen && !expandedDirs.includes("")) toggleDir("")
            }}
            style={styles.directoryAddButton}
          >
            <Icon name={directoryTreeOpen ? "chevronDown" : "chevronRight"} size={19} color={colors.muted} />
          </Pressable>
          <View style={styles.directoryInputBox}>
            {/* Locked home prefix: the user types only the part after "~/",
                so the target always stays under the home directory and the
                prefix cannot be deleted by accident. */}
            {!directoryInput.startsWith("/") ? <Text style={styles.directoryPrefix}>~/</Text> : null}
            <TextInput
              value={directoryInput}
              // A pasted absolute or ~/ path is normalized into the suffix;
              // the "~" itself is rendered by the locked prefix next to it.
              onChangeText={(value) => {
                setDirectoryCheck(null)
                setDirectoryInput(value.replace(/^~\/?/, ""))
              }}
              accessibilityLabel={t("newSessionDirectory")}
              placeholder={t("directoryPlaceholder")}
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.directoryInput}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("newSession")}
            disabled={creating || !opencodeOnline || readOnly || directoryChecking || !directoryCheck?.valid || !directoryCheck.path}
            onPress={() => {
              if (directoryCheck?.valid && directoryCheck.path) void createSessionIn(directoryCheck.path)
            }}
            style={({ pressed }) => [
              styles.directoryAddButton,
              (creating || !opencodeOnline || readOnly || directoryChecking || !directoryCheck?.valid || !directoryCheck.path) && { opacity: 0.35 },
              pressed && { opacity: 0.6 },
            ]}
          >
            <Icon name="plus" size={19} color={colors.accent} />
          </Pressable>
        </View>

        {directoryChecking ? <Text style={styles.directoryHint}>{t("directoryChecking")}</Text> : null}
        {directoryCheck?.valid === false ? (
          <Text accessibilityLiveRegion="polite" style={[styles.directoryHint, { color: colors.danger }]}>
            {t("directoryInvalid", { message: directoryCheck.error ?? t("directoryEmpty") })}
          </Text>
        ) : null}
        {directoryError ? (
          <Text style={[styles.directoryHint, { color: colors.danger }]}>{directoryError}</Text>
        ) : null}

        {directoryTreeOpen ? (
          <View style={styles.directoryTree}>{renderDirRows("", dirHome ? basename(dirHome) : t("homeDirectory"), 0)}</View>
        ) : null}

        <View style={styles.panelDivider} />
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
              disabled={creating || !opencodeOnline || readOnly}
              onPress={() => void createSessionIn(project.canonical)}
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

      <BottomSheet visible={activityOpen} title={t("backgroundTasks")} onClose={() => setActivityOpen(false)} height={panelHeight}>
        {activities.length === 0 ? <Text style={styles.sheetMuted}>{t("backgroundNone")}</Text> : null}
        {activities.map((activity) => (
          <ActivityRow
            key={activity.key}
            activity={activity}
            {...(!readOnly && (activity.kind !== "shell" || (activity.shellId && session?.location?.directory))
              ? { onStop: () => stopActivity(activity) }
              : {})}
            stopDisabled={!canStop}
            stopLabel={t("backgroundStop")}
          />
        ))}
        {showStop && !readOnly ? (
          <View style={{ marginTop: 10 }}>
            <Button
              label={t("stop")}
              size="sm"
              variant="danger"
              disabled={!canStop}
              onPress={() => void stopTasks(runningTargets, cancellable)}
            />
          </View>
        ) : null}
      </BottomSheet>

      <BottomSheet
        visible={panelOpen}
        title={panelMode === "main" ? t("sessionSettings") : panelTitle(panelMode, t)}
        onClose={() => setPanelOpen(false)}
        height={panelHeight}
      >
        <Animated.View style={{ opacity: panelFade, transform: [{ translateX: panelShift }] }}>
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
            <SheetRow
              icon="activity"
              label={t("statusTitle")}
              value={active ? t("statusRunning") : t("statusIdle")}
              onPress={() => setPanelMode("status")}
            />
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
          ? displayAgents.map((agent) => (
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
                {agent.id === activeAgentId ? <Icon name="check" size={18} color={colors.accent} /> : null}
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
                    model.modelID === (session?.model?.id ?? defaultModel?.modelID) &&
                    model.providerID === (session?.model?.providerID ?? defaultModel?.providerID)
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
            <Text style={styles.sheetMuted}>{t("skillAttachHint")}</Text>
            {selectedSkills.length > 0 ? (
              <Text style={[styles.sheetMuted, { color: colors.accent }]}>
                {t("skillAttached", { n: selectedSkills.length })}
              </Text>
            ) : null}
            {skills === null ? <Text style={styles.sheetMuted}>{t("loading")}</Text> : null}
            {skills?.length === 0 ? <Text style={styles.sheetMuted}>{t("noSkills")}</Text> : null}
            {(skills ?? []).map((skill) => {
              const selected = selectedSkills.some((item) => item.id === skill.id)
              return (
                <Pressable
                  key={skill.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  onPress={() => toggleSkill(skill)}
                  style={({ pressed }) => [
                    styles.optionRow,
                    pressed && { opacity: 0.7 },
                    selected && { backgroundColor: colors.accentSoft },
                  ]}
                >
                  <Icon name="spark" size={16} color={selected ? colors.accent : colors.muted} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={[styles.optionTitle, selected && { color: colors.accent }]}>{skill.name}</Text>
                      {skill.autoinvoke ? <Badge text={t("autoInvoke")} tone="accent" /> : null}
                    </View>
                    {skill.description ? (
                      <Text style={styles.optionBody} numberOfLines={2}>
                        {skill.description}
                      </Text>
                    ) : null}
                  </View>
                  {selected ? <Icon name="check" size={18} color={colors.accent} /> : null}
                </Pressable>
              )
            })}
          </View>
        ) : null}

        {panelMode === "status" ? (
          <View>
            <StatusRow label={t("agent")} value={agentName} />
            <StatusRow label={t("model")} value={modelName} />
            <StatusRow label={t("reasoningDepth")} value={variantName} />
            <StatusRow label={t("statusState")} value={active ? t("statusRunning") : t("statusIdle")} />
            <StatusRow
              label={t("statusContext")}
              value={`${contextTokens}${usage?.percent !== undefined ? ` · ${usage.percent}%` : ""}`}
            />
            <StatusRow label={t("statusSession")} value={sessionId ?? t("noContext")} />
            <StatusRow label={t("statusDirectory")} value={session?.location?.directory ?? t("noContext")} />
          </View>
        ) : null}

        {panelMode === "help" ? (
          <View>
            <Text style={styles.sheetMuted}>{t("commandGroupsHint")}</Text>
            {commandGroups.map((group) => (
              <View key={group.category} style={{ marginTop: 6 }}>
                <Text style={styles.providerLabel}>{group.label}</Text>
                {group.commands.map((command) => (
                  <Pressable
                    key={command.name}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !command.enabled }}
                    disabled={!command.enabled}
                    onPress={command.run}
                    style={({ pressed }) => [
                      styles.optionRow,
                      pressed && { opacity: 0.7 },
                      !command.enabled && { opacity: 0.4 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.commandName,
                        { minWidth: 88 },
                        !command.enabled && { color: colors.faint },
                      ]}
                    >
                      /{command.name}
                    </Text>
                    <Text style={styles.commandDescription} numberOfLines={1}>
                      {command.description}
                    </Text>
                  </Pressable>
                ))}
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
        </Animated.View>
      </BottomSheet>
    </KeyboardAvoidingView>
  )
}

function StatusRow(props: { label: string; value: string }) {
  const { colors } = useTheme()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 11,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
      }}
    >
      <Text style={{ width: 96, fontSize: 13, color: colors.faint }}>{props.label}</Text>
      <Text style={{ flex: 1, fontSize: 13.5, color: colors.text }} selectable>
        {props.value}
      </Text>
    </View>
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

/**
 * One background task in the sheet. Tapping the row expands the details the
 * task itself carries: current status, how long it has been running, what it
 * is operating on (tool input summary, shell command, subagent agent), and the
 * live error when the tool reports one.
 */
function ActivityRow(props: {
  activity: RunningActivity
  onStop?: () => void
  stopDisabled: boolean
  stopLabel: string
}) {
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(workspaceStyles)
  const [expanded, setExpanded] = useState(false)
  const icon = props.activity.kind === "subagent" ? "spark" : props.activity.kind === "shell" ? "terminal" : "activity"
  const status = props.activity.kind === "subagent" ? undefined : props.activity.status
  const elapsed = props.activity.started ? Math.max(0, Date.now() - props.activity.started) : undefined
  const elapsedLabel =
    elapsed === undefined
      ? undefined
      : elapsed < 60_000
        ? `${Math.round(elapsed / 1000)}s`
        : `${Math.floor(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1000)}s`
  const lines: string[] = []
  if (status) lines.push(`${t("activityStatus")}: ${status}`)
  if (elapsedLabel) lines.push(`${t("activityElapsed")}: ${elapsedLabel}`)
  if (props.activity.detail) lines.push(props.activity.detail)
  if (props.activity.kind === "tool" && props.activity.error) lines.push(`${t("activityError")}: ${props.activity.error}`)
  return (
    <View style={styles.optionRow}>
      <Icon name={icon} size={17} color={colors.muted} />
      <View style={{ flex: 1 }}>
        {/* Only the header row toggles. Details live outside the pressable so
            tapping or scrolling the expanded content never collapses it. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((current) => !current)}
          style={({ pressed }) => [styles.activityRowHeader, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.optionTitle} numberOfLines={1}>
            {props.activity.label}
          </Text>
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} color={colors.faint} />
        </Pressable>
        <Text style={styles.optionBody}>{props.activity.kind}</Text>
        {expanded && lines.length > 0 ? (
          <View style={{ marginTop: 6, gap: 3 }}>
            {lines.map((line, index) => (
              <Text
                key={index}
                style={[styles.activityDetail, props.activity.kind === "tool" && props.activity.error && index === lines.length - 1 && { color: colors.danger }]}
                numberOfLines={4}
              >
                {line}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
      {props.onStop ? (
        <Button label={props.stopLabel} size="sm" variant="outline" disabled={props.stopDisabled} onPress={props.onStop} />
      ) : null}
    </View>
  )
}

function VoicePanel(props: {
  stage: "recording" | "confirm"
  error: string | null
  engine: VoiceEngine | null
  onStop: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(voicePanelStyles)
  const [seconds, setSeconds] = useState(0)
  const opacity = useRef(new Animated.Value(0)).current
  const offset = useRef(new Animated.Value(14)).current
  const bars = useRef(Array.from({ length: 5 }, () => new Animated.Value(0.35))).current

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(offset, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start()
  }, [offset, opacity])

  useEffect(() => {
    if (props.stage !== "recording" || props.error) return
    setSeconds(0)
    const timer = setInterval(() => setSeconds((value) => value + 1), 1_000)
    return () => clearInterval(timer)
  }, [props.error, props.stage])

  useEffect(() => {
    if (props.stage !== "recording" || props.error) return
    const animations = bars.map((bar, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 90),
          Animated.timing(bar, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(bar, { toValue: 0.35, duration: 360, useNativeDriver: true }),
          Animated.delay((bars.length - index) * 60),
        ]),
      ),
    )
    animations.forEach((animation) => animation.start())
    return () => {
      animations.forEach((animation) => animation.stop())
      bars.forEach((bar) => bar.setValue(0.35))
    }
  }, [bars, props.error, props.stage])

  const engineLabel =
    props.engine === "host"
      ? t("engineHost")
      : props.engine === "local"
        ? t("engineLocal")
        : props.engine === "system"
          ? t("engineSystem")
          : t("engineAuto")

  return (
    <Animated.View style={[styles.panel, { opacity, transform: [{ translateY: offset }] }]}>
      {props.stage === "recording" ? (
        <View style={styles.row}>
          <View style={styles.wave}>
            {bars.map((bar, index) => (
              <Animated.View key={index} style={[styles.waveBar, { transform: [{ scaleY: bar }] }]} />
            ))}
          </View>
          <View style={styles.copy}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.title, props.error && { color: colors.danger }]} numberOfLines={1}>
                {props.error ?? t("voicePanelRecording")}
              </Text>
              {!props.error ? <Text style={styles.timer}>{formatSeconds(seconds)}</Text> : null}
            </View>
            <Text style={styles.hint} numberOfLines={2}>
              {props.error ? t("voicePanelErrorHint") : t("voicePanelHint", { engine: engineLabel })}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.error ? t("close") : t("stop")}
            onPress={props.error ? props.onCancel : props.onStop}
            style={({ pressed }) => [
              props.error ? styles.closeButton : styles.stopButton,
              pressed && { opacity: 0.72 },
            ]}
          >
            {props.error ? (
              <Icon name="close" size={18} color={colors.muted} />
            ) : (
              <Icon name="stop" size={15} color="#FFFFFF" />
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.row}>
          <View style={[styles.confirmIcon, { backgroundColor: colors.accentSoft }]}>
            <Icon name="mic" size={18} color={colors.accent} />
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>{t("voicePanelReady")}</Text>
            <Text style={styles.hint} numberOfLines={2}>
              {t("voicePanelConfirmHint", { engine: engineLabel })}
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={props.onCancel}
              style={({ pressed }) => [styles.cancelButton, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.cancelText}>{t("cancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={props.onConfirm}
              style={({ pressed }) => [styles.confirmButton, pressed && { opacity: 0.8 }]}
            >
              <Text style={styles.confirmText}>{t("confirm")}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </Animated.View>
  )
}

function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

const voicePanelStyles = (colors: Palette) =>
  StyleSheet.create({
    panel: {
      minHeight: 64,
      marginTop: 6,
      marginHorizontal: 4,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      justifyContent: "center",
    },
    row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
    wave: { width: 44, height: 26, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 },
    waveBar: { width: 3, height: 20, borderRadius: 2, backgroundColor: colors.danger },
    copy: { flex: 1, minWidth: 0 },
    title: { fontSize: 13, fontWeight: "600", color: colors.text },
    timer: { fontSize: 11, color: colors.muted, fontFamily: "monospace" },
    hint: { marginTop: 2, fontSize: 11, lineHeight: 16, color: colors.faint },
    stopButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.danger,
    },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    confirmIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
    actions: { flexDirection: "row", alignItems: "center", gap: 6 },
    cancelButton: {
      height: 34,
      paddingHorizontal: 12,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
    },
    cancelText: { fontSize: 12, fontWeight: "600", color: colors.muted },
    confirmButton: {
      height: 34,
      paddingHorizontal: 14,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
    },
    confirmText: { fontSize: 12, fontWeight: "700", color: colors.accentText },
  })

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
    case "status":
      return t("statusTitle")
    case "help":
      return t("commandHelp")
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
    const live = run.some((message) => message.metadata?.live === true)
    const streaming = run.some((message) => message.metadata?.streaming === true)
    const finishing = run.some((message) => message.metadata?.finishing === true)
    result.push({
      ...first,
      ...(content.length > 0 ? { content } : {}),
      ...(last.time ? { time: last.time } : {}),
      ...(errors.length > 0 ? { error: { message: errors.join("\n") } } : {}),
      ...(live
        ? {
            metadata: {
              ...first.metadata,
              live: true,
              ...(streaming ? { streaming: true } : {}),
              ...(finishing ? { finishing: true } : {}),
            },
          }
        : {}),
    })
    run = []
  }
  for (const message of messages) {
    if (
      message.type !== "user" &&
      message.type !== "assistant" &&
      message.type !== "shell" &&
      message.type !== "compaction"
    ) {
      continue
    }
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

function queueOnly(items: InboxItem[]): InboxItem[] {
  return items.filter((item) => item.type === "user")
}

function messageWeight(message: SessionMessage): number {
  let weight = 0
  for (const block of message.content ?? []) {
    if (block.type === "text") weight += block.text.length
    else if (block.type === "reasoning") weight += block.text.length
    else weight += 16
  }
  return weight + (message.text?.length ?? 0)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function eventSessionID(event: OpencodeEvent): string | undefined {
  const data = asRecord(event.data)
  const info = asRecord(data.info)
  const message = asRecord(data.message)
  for (const source of [event, data, info, message]) {
    for (const key of ["sessionID", "sessionId"]) {
      const value = source[key]
      if (typeof value === "string" && value) return value
    }
  }
  return undefined
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
    opencodeBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginTop: 8,
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    opencodeBarText: { flex: 1, fontSize: 11.5, lineHeight: 16, color: colors.muted },
    opencodeBarAction: { fontSize: 11.5, fontWeight: "600", color: colors.accent },
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
    jumpDot: { position: "absolute", top: 7, right: 7, width: 7, height: 7, borderRadius: 4 },
    activitySlot: {
      position: "relative",
      height: 44,
      justifyContent: "center",
      paddingLeft: 14,
      paddingRight: 62,
      zIndex: 4,
    },
    activityPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      maxWidth: "100%",
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      alignSelf: "flex-start",
    },
    activityText: { fontSize: 12, fontWeight: "600", color: colors.muted },
    // Slightly smaller circle than the slot height and nudged off the reserved
    // row's edges, with a square stop glyph inside ("外圆内方").
    stopTaskButton: {
      position: "absolute",
      right: 14,
      top: 3,
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.danger,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.24)",
      shadowColor: "#000000",
      shadowOpacity: 0.22,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 6,
      zIndex: 8,
    },
    error: { marginHorizontal: 16, marginBottom: 4, fontSize: 12.5, color: colors.danger },
    composer: { paddingHorizontal: 10, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.bg },
    reviewStaging: {
      marginHorizontal: 4,
      marginBottom: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 6,
    },
    reviewStagingHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    reviewStagingTitle: { flex: 1, fontSize: 11.5, fontWeight: "600", color: colors.muted },
    reviewCardList: { maxHeight: 152 },
    reviewCardListContent: { gap: 6 },
    reviewCard: {
      paddingHorizontal: 9,
      paddingVertical: 7,
      borderRadius: 9,
      backgroundColor: colors.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 3,
    },
    reviewCardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    reviewCardPath: { flex: 1, fontSize: 11, color: colors.accent, fontFamily: "monospace" },
    reviewCardBody: { fontSize: 12, lineHeight: 17, color: colors.text },
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
    skillChips: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      marginHorizontal: 4,
      marginBottom: 6,
    },
    skillChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      maxWidth: "100%",
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.accentSoft,
    },
    skillChipText: { maxWidth: 180, fontSize: 11.5, fontWeight: "600", color: colors.accent },
    voiceBar: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 4, marginBottom: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.surface },
    voiceText: { flex: 1, fontSize: 12, color: colors.muted },
    voiceStop: { fontSize: 12, fontWeight: "600", color: colors.accent },
    notice: { marginHorizontal: 6, marginBottom: 5, fontSize: 11.5, color: colors.muted },
    commandPanel: { maxHeight: 220, marginHorizontal: 4, marginBottom: 6, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" },
    commandRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 11, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    commandName: { fontSize: 12.5, fontWeight: "600", color: colors.accent, fontFamily: "monospace" },
    commandDescription: { flex: 1, fontSize: 11, color: colors.faint },
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
    directoryBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 4,
      marginBottom: 2,
    },
    // Input box with the locked "~" home prefix rendered to its left.
    directoryInputBox: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      height: 38,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
    },
    directoryPrefix: {
      fontSize: 13,
      fontFamily: "monospace",
      color: colors.muted,
      marginRight: 2,
    },
    directoryInput: {
      flex: 1,
      height: 38,
      paddingHorizontal: 2,
      paddingVertical: 0,
      fontSize: 13,
      fontFamily: "monospace",
      color: colors.text,
    },
    directoryHint: { fontSize: 11.5, lineHeight: 17, color: colors.faint, marginTop: 4 },
    directoryTree: { marginTop: 8, gap: 1 },
    directoryChevron: {
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 6,
    },
    directoryAdd: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 7,
      backgroundColor: colors.accentSoft,
    },
    directoryAddButton: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    directoryRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 5,
      minHeight: 30,
    },
    directoryRowText: { flex: 1, fontSize: 13.5, color: colors.text },
    optionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    optionTitle: { fontSize: 14.5, fontWeight: "500", color: colors.text },
    optionBody: { fontSize: 11.5, color: colors.faint, marginTop: 2 },
    activityRowHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 2,
    },
    activityDetail: {
      fontSize: 12,
      lineHeight: 17,
      fontFamily: "monospace",
      color: colors.muted,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
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
