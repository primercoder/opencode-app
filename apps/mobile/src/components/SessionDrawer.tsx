import { useEffect, useRef, useState } from "react"
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { IconButton } from "@/components/ui"
import { useT } from "@/i18n"
import { relativeTime } from "@/lib/time"
import { sessionBusy, sessionUpdatedAt, type SessionInfo } from "@/opencode/client"
import { useSessionIndex, type SessionGroup } from "@/features/sessions/useSessionIndex"
import { usePreferences } from "@/stores/preferences"
import { useTheme } from "@/theme"

export function SessionDrawer(props: {
  visible: boolean
  hostId: string
  hostName: string
  currentSessionId?: string
  onClose: () => void
  onSelect: (session: SessionInfo) => void
  onNewSession: () => void
  onHosts: () => void
}) {
  const { colors } = useTheme()
  const t = useT()
  const language = usePreferences((state) => state.language)
  const insets = useSafeAreaInsets()
  const index = useSessionIndex(props.hostId, props.visible)
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const slide = useRef(new Animated.Value(-360)).current
  const fade = useRef(new Animated.Value(0)).current
  const [mounted, setMounted] = useState(props.visible)

  useEffect(() => {
    if (props.visible) {
      setMounted(true)
      setQuery("")
      Animated.parallel([
        Animated.timing(slide, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start()
    } else {
      Animated.parallel([
        Animated.timing(slide, { toValue: -360, duration: 180, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false)
      })
    }
  }, [props.visible, slide, fade])

  if (!mounted) return null

  const value = query.trim().toLowerCase()
  const filteredGroups: SessionGroup[] = value
    ? [
        {
          key: "search",
          name: "",
          sessions: index.groups
            .flatMap((group) => group.sessions)
            .filter(
              (session) =>
                (session.title ?? "").toLowerCase().includes(value) ||
                (session.location?.directory ?? "").toLowerCase().includes(value),
            ),
          updatedAt: 0,
        },
      ]
    : index.groups

  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={props.onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlap, opacity: fade }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
      </Animated.View>
      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 330,
          maxWidth: "88%",
          backgroundColor: colors.bg,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderRightColor: colors.border,
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 8,
          transform: [{ translateX: slide }],
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingBottom: 10, gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text }} numberOfLines={1}>
              {props.hostName}
            </Text>
            <Text style={{ fontSize: 11.5, color: colors.faint, marginTop: 2 }}>{t("encrypted")}</Text>
          </View>
          <IconButton label={t("close")} onPress={props.onClose}>
            <Icon name="close" size={20} color={colors.muted} />
          </IconButton>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            props.onClose()
            props.onHosts()
          }}
          style={({ pressed }) => [
            {
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginHorizontal: 12,
              paddingHorizontal: 12,
              paddingVertical: 11,
              borderRadius: 12,
              backgroundColor: colors.surface,
            },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Icon name="server" size={18} color={colors.muted} />
          <Text style={{ flex: 1, fontSize: 14, fontWeight: "500", color: colors.text }}>{t("hostList")}</Text>
          <Icon name="chevronRight" size={16} color={colors.faint} />
        </Pressable>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 12, marginTop: 14 }}>
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              backgroundColor: colors.surface,
              borderRadius: 10,
              paddingHorizontal: 10,
              height: 38,
            }}
          >
            <Icon name="search" size={16} color={colors.faint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("searchSessions")}
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, fontSize: 13.5, color: colors.text, paddingVertical: 0 }}
            />
            {query ? (
              <Pressable accessibilityRole="button" onPress={() => setQuery("")} hitSlop={8}>
                <Icon name="close" size={14} color={colors.faint} />
              </Pressable>
            ) : null}
          </View>
          <IconButton
            label={t("newSession")}
            onPress={() => {
              props.onClose()
              props.onNewSession()
            }}
          >
            <Icon name="plus" size={20} color={colors.accent} />
          </IconButton>
        </View>

        <ScrollView
          style={{ flex: 1, marginTop: 8 }}
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {index.loading && index.sessions === null ? (
            <Text style={{ fontSize: 13, color: colors.faint, textAlign: "center", marginTop: 24 }}>{t("loadingSessions")}</Text>
          ) : null}
          {index.error ? (
            <Pressable onPress={() => void index.reload()} style={{ padding: 12 }}>
              <Text style={{ fontSize: 12.5, color: colors.danger }}>{t("networkError", { message: index.error })}</Text>
              <Text style={{ fontSize: 12.5, color: colors.accent, marginTop: 4 }}>{t("retry")}</Text>
            </Pressable>
          ) : null}

          {value ? (
            <View>
              {filteredGroups[0]?.sessions.length === 0 ? (
                <Text style={{ fontSize: 13, color: colors.faint, textAlign: "center", marginTop: 24 }}>{t("noMatch")}</Text>
              ) : null}
              {filteredGroups[0]?.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === props.currentSessionId}
                  time={relativeTime(sessionUpdatedAt(session), language)}
                  onPress={() => {
                    props.onClose()
                    props.onSelect(session)
                  }}
                  nested
                />
              ))}
            </View>
          ) : (
            filteredGroups.map((group) => {
              const isCollapsed = collapsed.has(group.key)
              return (
                <View key={group.key} style={{ marginTop: 6 }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      setCollapsed((current) => {
                        const next = new Set(current)
                        if (next.has(group.key)) next.delete(group.key)
                        else next.add(group.key)
                        return next
                      })
                    }
                    style={({ pressed }) => [
                      { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 7, paddingHorizontal: 6 },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Icon name={isCollapsed ? "chevronRight" : "chevronDown"} size={14} color={colors.faint} />
                    <Icon name="folder" size={16} color={colors.muted} />
                    <Text
                      style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.muted }}
                      numberOfLines={1}
                    >
                      {group.name}
                    </Text>
                    <Text style={{ fontSize: 11, color: colors.faint }}>{group.sessions.length}</Text>
                  </Pressable>
                  {!isCollapsed
                    ? group.sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          active={session.id === props.currentSessionId}
                          time={relativeTime(sessionUpdatedAt(session), language)}
                          onPress={() => {
                            props.onClose()
                            props.onSelect(session)
                          }}
                          nested
                        />
                      ))
                    : null}
                </View>
              )
            })
          )}
        </ScrollView>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 8 }}>
          <Icon name="lock" size={12} color={colors.faint} />
          <Text style={{ fontSize: 10.5, color: colors.faint }}>{t("encrypted")}</Text>
        </View>
      </Animated.View>
    </Modal>
  )
}

function SessionRow(props: {
  session: SessionInfo
  active: boolean
  time: string
  onPress: () => void
  nested?: boolean
}) {
  const { colors } = useTheme()
  const busy = sessionBusy(props.session)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      onPress={props.onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginLeft: props.nested ? 18 : 0,
          paddingVertical: 9,
          paddingHorizontal: 8,
          borderRadius: 10,
          backgroundColor: props.active ? colors.accentSoft : "transparent",
        },
        pressed && { opacity: 0.7 },
      ]}
    >
      {busy ? (
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent }} />
      ) : (
        <Icon name="message" size={14} color={props.active ? colors.accent : colors.faint} />
      )}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontSize: 13.5,
            fontWeight: props.active ? "600" : "500",
            color: props.active ? colors.accent : colors.text,
          }}
          numberOfLines={1}
        >
          {props.session.title?.trim() || "—"}
        </Text>
        <Text style={{ fontSize: 10.5, color: colors.faint, marginTop: 1 }} numberOfLines={1}>
          {props.time}
        </Text>
      </View>
    </Pressable>
  )
}
