import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { BottomSheet } from "@/components/BottomSheet"
import { Icon } from "@/components/Icon"
import { SessionDrawer } from "@/components/SessionDrawer"
import { Button, Card, EmptyState, IconButton } from "@/components/ui"
import { useT } from "@/i18n"
import { relativeTime } from "@/lib/time"
import { basename, useSessionIndex } from "@/features/sessions/useSessionIndex"
import { OpencodeClient, sessionBusy, sessionUpdatedAt, type ProjectInfo, type SessionInfo } from "@/opencode/client"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { usePreferences } from "@/stores/preferences"
import { ensureConnection } from "@/transport/runtimes"
import { useForeground } from "@/lib/useForeground"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

export default function SessionsScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string; new?: string }>()
  const hostId = params.hostId
  const { colors } = useTheme()
  const t = useT()
  const language = usePreferences((state) => state.language)
  const styles = useThemedStyles(sessionsStyles)
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const index = useSessionIndex(hostId, Boolean(hostId))
  const [query, setQuery] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const newHandled = useRef(false)
  const ready = connection?.status === "ready"
  const readOnly = connection?.session?.device?.scope === "read"

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  useEffect(() => {
    if (!hostId) return
    void ensureConnection(hostId).catch(() => undefined)
  }, [hostId])

  useForeground(
    useCallback(() => {
      void ensureConnection(hostId, { force: true })
        .then(() => index.reload({ silent: true }))
        .catch(() => undefined)
    }, [hostId, index.reload]),
  )

  const openPicker = useCallback(async () => {
    setPickerOpen(true)
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
    if (params.new !== "1" || !ready || newHandled.current) return
    newHandled.current = true
    void openPicker()
  }, [params.new, ready, openPicker])

  const createSession = async (project: ProjectInfo) => {
    if (creating) return
    setCreating(true)
    setProjectError(null)
    try {
      const runtime = await ensureConnection(hostId)
      const session = await new OpencodeClient(runtime).createSession({
        location: { directory: project.canonical },
      })
      setPickerOpen(false)
      await index.reload({ silent: true })
      router.push({
        pathname: "/hosts/[hostId]/sessions/[sessionId]",
        params: { hostId, sessionId: session.id },
      })
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setCreating(false)
    }
  }

  const value = query.trim().toLowerCase()
  const groups = useMemo(() => {
    if (!value) return index.groups
    return index.groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter(
          (session) =>
            (session.title ?? "").toLowerCase().includes(value) ||
            (session.location?.directory ?? "").toLowerCase().includes(value),
        ),
      }))
      .filter((group) => group.sessions.length > 0)
  }, [index.groups, value])

  const openSession = (session: SessionInfo) => {
    router.push({
      pathname: "/hosts/[hostId]/sessions/[sessionId]",
      params: { hostId, sessionId: session.id },
    })
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <IconButton label={t("sessions")} onPress={() => setDrawerOpen(true)}>
          <Icon name="menu" size={22} color={colors.text} />
        </IconButton>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>{t("allSessions")}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {host?.name ?? t("hosts")} · {connection?.status === "ready" ? t("encrypted") : t("offline")}
          </Text>
        </View>
        <IconButton label={t("newSession")} onPress={() => void openPicker()} disabled={!ready || readOnly}>
          <Icon name="plus" size={22} color={ready && !readOnly ? colors.accent : colors.faint} />
        </IconButton>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Icon name="search" size={16} color={colors.faint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("searchSessions")}
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable accessibilityRole="button" onPress={() => setQuery("")} hitSlop={8}>
              <Icon name="close" size={14} color={colors.faint} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {!ready && connection?.status === "error" ? (
        <Card style={{ marginHorizontal: 16, padding: 14 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{t("hostOffline")}</Text>
          <Text style={{ fontSize: 12.5, color: colors.muted, marginTop: 4, lineHeight: 18 }}>
            {connection.error?.message ?? t("hostOfflineBody")}
          </Text>
          <View style={{ marginTop: 10, alignSelf: "flex-start" }}>
            <Button label={t("retry")} size="sm" onPress={() => void ensureConnection(hostId, { force: true }).catch(() => undefined)} />
          </View>
        </Card>
      ) : null}

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={index.refreshing}
            onRefresh={() => void index.reload({ silent: true, hard: true })}
            tintColor={colors.muted}
          />
        }
      >
        {index.error ? (
          <Pressable onPress={() => void index.reload()} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <Text style={{ fontSize: 12.5, color: colors.danger }}>{t("networkError", { message: index.error })}</Text>
          </Pressable>
        ) : null}

        {index.loading && index.sessions === null ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
        ) : null}

        {!index.loading && groups.length === 0 ? (
          <EmptyState
            icon={<Icon name="message" size={34} color={colors.faint} />}
            title={value ? t("noMatch") : t("noSessions")}
            body={value ? t("noMatchBody") : t("noSessionsBody")}
          />
        ) : null}

        {groups.map((group) => (
          <View key={group.key} style={{ marginBottom: 18 }}>
            <View style={styles.groupHeader}>
              <Icon name="folder" size={15} color={colors.muted} />
              <Text style={styles.groupName} numberOfLines={1}>
                {group.name}
              </Text>
              <Text style={styles.groupCount}>{group.sessions.length}</Text>
            </View>
            <View style={styles.groupBody}>
              {group.sessions.map((session, sessionIndex) => (
                <View key={session.id}>
                  {sessionIndex > 0 ? <View style={styles.rowDivider} /> : null}
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => openSession(session)}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.65 }]}
                  >
                    {sessionBusy(session) ? (
                      <View style={styles.busyDot} />
                    ) : (
                      <Icon name="message" size={15} color={colors.faint} />
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {session.title?.trim() || "—"}
                      </Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {relativeTime(sessionUpdatedAt(session), language)}
                      </Text>
                    </View>
                    <Icon name="chevronRight" size={15} color={colors.faint} />
                  </Pressable>
                </View>
              ))}
              {!readOnly ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    const project = index.projects.find((item) => item.canonical === group.directory)
                    if (project) void createSession(project)
                    else void openPicker()
                  }}
                  style={({ pressed }) => [styles.newRow, pressed && { opacity: 0.6 }]}
                >
                  <Icon name="plus" size={14} color={colors.accent} />
                  <Text style={{ fontSize: 12.5, color: colors.accent, fontWeight: "500" }}>
                    {t("newSessionIn")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}
      </ScrollView>

      <SessionDrawer
        visible={drawerOpen}
        hostId={hostId}
        hostName={host?.name ?? t("hosts")}
        onClose={() => setDrawerOpen(false)}
        onSelect={(session) => {
          setDrawerOpen(false)
          openSession(session)
        }}
        onNewSession={() => void openPicker()}
        onHosts={() => router.replace("/")}
      />

      <BottomSheet visible={pickerOpen} title={t("chooseProject")} onClose={() => setPickerOpen(false)}>
        {projectError ? <Text style={{ fontSize: 12.5, color: colors.danger, marginBottom: 8 }}>{projectError}</Text> : null}
        {projects === null ? (
          <Text style={{ fontSize: 13, color: colors.faint, paddingVertical: 20, textAlign: "center" }}>
            {t("loadingProjects")}
          </Text>
        ) : projects.length === 0 ? (
          <Text style={{ fontSize: 13, color: colors.faint, paddingVertical: 20, textAlign: "center" }}>
            {t("noProjects")}
          </Text>
        ) : (
          projects.map((project) => (
            <Pressable
              key={project.id}
              accessibilityRole="button"
              disabled={creating}
              onPress={() => void createSession(project)}
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
              <Icon name="folder" size={18} color={colors.muted} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "500", color: colors.text }} numberOfLines={1}>
                  {project.name?.trim() || basename(project.canonical)}
                </Text>
                <Text style={{ fontSize: 11.5, color: colors.faint, marginTop: 2 }} numberOfLines={1}>
                  {project.canonical}
                </Text>
              </View>
              {creating ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            </Pressable>
          ))
        )}
      </BottomSheet>
    </View>
  )
}

const sessionsStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 8,
      paddingBottom: 8,
      gap: 4,
    },
    headerCenter: { flex: 1, alignItems: "center" },
    title: { fontSize: 17, fontWeight: "700", color: colors.text },
    subtitle: { marginTop: 2, fontSize: 11, color: colors.muted },
    searchRow: { paddingHorizontal: 16, paddingBottom: 8 },
    search: {
      height: 40,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    searchInput: { flex: 1, fontSize: 13.5, color: colors.text, paddingVertical: 0 },
    content: { paddingHorizontal: 16, paddingBottom: 32 },
    groupHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 2 },
    groupName: { flex: 1, fontSize: 12.5, fontWeight: "600", color: colors.muted },
    groupCount: { fontSize: 11, color: colors.faint },
    groupBody: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    },
    row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, paddingVertical: 11 },
    rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 38 },
    rowTitle: { fontSize: 14, fontWeight: "500", color: colors.text },
    rowMeta: { fontSize: 11, color: colors.faint, marginTop: 2 },
    busyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
    newRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
  })
