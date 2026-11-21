import { useEffect, useMemo, useState } from "react"
import { Animated, Easing, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
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
  active: boolean
  progress: Animated.Value
  width: number
  hostId: string
  hostName: string
  currentSessionId?: string
  /** True while the host is reachable but opencode is down. */
  opencodeOffline?: boolean
  onClose: () => void
  onSelect: (session: SessionInfo) => void
  onNewSession: () => void
  onSettings?: () => void
  statusLabel?: string
}) {
  const { colors } = useTheme()
  const t = useT()
  const language = usePreferences((state) => state.language)
  const insets = useSafeAreaInsets()
  const index = useSessionIndex(props.hostId, props.active)
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (props.visible) setQuery("")
  }, [props.visible])

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          props.visible &&
          Math.abs(gesture.dx) > 7 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
        onPanResponderMove: (_event, gesture) => {
          props.progress.setValue(clamp(1 + gesture.dx / props.width, 0, 1))
        },
        onPanResponderRelease: (_event, gesture) => {
          const next = clamp(1 + gesture.dx / props.width, 0, 1)
          if (next < 0.72 || gesture.vx < -0.35) {
            props.onClose()
            return
          }
          Animated.timing(props.progress, {
            toValue: 1,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start()
        },
        onPanResponderTerminate: () => {
          Animated.timing(props.progress, {
            toValue: 1,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start()
        },
      }),
    [props.onClose, props.progress, props.visible, props.width],
  )

  const translateX = props.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-props.width, 0],
  })

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
    <View pointerEvents={props.visible ? "box-none" : "none"} style={styles.overlay}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlap, opacity: props.progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
      </Animated.View>
      <Animated.View
        {...pan.panHandlers}
        renderToHardwareTextureAndroid
        shouldRasterizeIOS
        style={[
          styles.panel,
          {
            width: props.width,
            backgroundColor: colors.bg,
            borderRightColor: colors.border,
            paddingTop: insets.top + 8,
            paddingBottom: insets.bottom + 8,
            transform: [{ translateX }],
          },
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingBottom: 10, gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text }} numberOfLines={1}>
              {props.hostName}
            </Text>
            <Text style={{ fontSize: 11.5, color: colors.faint, marginTop: 2 }}>
              {props.statusLabel ?? t("connected")}
            </Text>
          </View>
          <IconButton label={t("close")} onPress={props.onClose}>
            <Icon name="close" size={20} color={colors.muted} />
          </IconButton>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 12, marginTop: 4 }}>
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
          {props.onSettings ? (
            <IconButton
              label={t("hostSettings")}
              onPress={() => {
                props.onClose()
                props.onSettings?.()
              }}
            >
              <Icon name="settings" size={20} color={colors.muted} />
            </IconButton>
          ) : null}
        </View>

        <ScrollView
          style={{ flex: 1, marginTop: 8 }}
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {index.loading && index.sessions === null ? (
            <Text style={{ fontSize: 13, color: colors.faint, textAlign: "center", marginTop: 24 }}>{t("loadingSessions")}</Text>
          ) : null}
          {index.error && !props.opencodeOffline ? (
            <Pressable onPress={() => void index.reload()} style={{ padding: 12 }}>
              <Text style={{ fontSize: 12.5, color: colors.danger }}>{t("networkError", { message: index.error })}</Text>
              <Text style={{ fontSize: 12.5, color: colors.accent, marginTop: 4 }}>{t("retry")}</Text>
            </Pressable>
          ) : null}
          {props.opencodeOffline ? (
            <Text style={{ fontSize: 12.5, color: colors.faint, textAlign: "center", marginTop: 16, paddingHorizontal: 12 }}>
              {t("opencodeOfflineShort")}
            </Text>
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
      </Animated.View>
    </View>
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
  const t = useT()
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 }}>
          {busy ? <Text style={{ fontSize: 10.5, color: colors.accent, fontWeight: "600" }}>{t("running")}</Text> : null}
          <Text style={{ fontSize: 10.5, color: colors.faint }} numberOfLines={1}>
            {props.time}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 20,
    elevation: 20,
  },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
})
