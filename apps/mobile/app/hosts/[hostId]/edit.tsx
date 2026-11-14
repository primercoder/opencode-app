import { router, useLocalSearchParams } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { Transport } from "@ocremote/protocol"
import { Icon } from "@/components/Icon"
import { RelayAccessCard } from "@/components/RelayAccessCard"
import { TransportAddSheet } from "@/components/TransportAddSheet"
import { Button, Card, Divider, IconButton, SectionLabel } from "@/components/ui"
import { useT } from "@/i18n"
import { useHosts } from "@/stores/hosts"
import { closeRuntime, testTransport } from "@/transport/runtimes"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

type RouteTest = {
  status: "testing" | "ok" | "failed"
  ms?: number
  error?: string
}

export default function EditHostScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(editStyles)
  const params = useLocalSearchParams<{ hostId: string }>()
  const hostId = params.hostId
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const renameHost = useHosts((state) => state.renameHost)
  const setTransports = useHosts((state) => state.setTransports)
  const removeHost = useHosts((state) => state.removeHost)

  const [name, setName] = useState(host?.name ?? "")
  const [routes, setRoutes] = useState<Transport[]>(host?.transports ?? [])
  const [addOpen, setAddOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [routeTests, setRouteTests] = useState<Record<string, RouteTest>>({})
  const routeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const relayRoute = routes.find((route) => route.kind === "relay")
  const relayRoom = relayRoute?.kind === "relay" ? relayRoute.room : ""
  const relayUrl = relayRoute?.kind === "relay" ? relayRoute.url : ""
  const trimmedName = name.trim()
  const dirty = Boolean(
    host &&
      (trimmedName !== host.name ||
        routeSignature(routes) !== routeSignature(host.transports)),
  )

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  useEffect(() => {
    if (!host) return
    setName(host.name)
    setRoutes(host.transports)
  }, [host?.id])

  useEffect(
    () => () => {
      for (const timer of Object.values(routeTimers.current)) clearTimeout(timer)
      routeTimers.current = {}
    },
    [],
  )

  const confirmLeave = () => {
    if (!dirty) {
      router.back()
      return
    }
    Alert.alert(t("unsavedTitle"), t("unsavedBody"), [
      { text: t("keepEditing"), style: "cancel" },
      { text: t("discardChanges"), style: "destructive", onPress: () => router.back() },
    ])
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!dirty) return false
      confirmLeave()
      return true
    })
    return () => subscription.remove()
    // confirmLeave reads the latest dirty/name/routes through this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, name, routes, t])

  if (!hydrated) return <View style={styles.screen} />

  if (!host) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 40, alignItems: "center" }]}>
        <Text style={styles.emptyTitle}>{t("hostMissing")}</Text>
        <View style={{ marginTop: 20 }}>
          <Button label={t("backToHosts")} onPress={() => router.replace("/")} />
        </View>
      </View>
    )
  }

  const save = async () => {
    if (!dirty || !trimmedName) return
    setBusy(true)
    setFormError(null)
    try {
      if (trimmedName !== host.name) await renameHost(host.id, trimmedName)
      await setTransports(host.id, routes)
      closeRuntime(host.id)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setBusy(false)
    }
  }

  const test = async (route: Transport) => {
    const key = routeKey(route)
    const previous = routeTimers.current[key]
    if (previous) clearTimeout(previous)
    setRouteTests((current) => ({ ...current, [key]: { status: "testing" } }))
    try {
      const ms = await testTransport(host.id, route)
      setRouteTests((current) => ({ ...current, [key]: { status: "ok", ms } }))
    } catch (cause) {
      setRouteTests((current) => ({
        ...current,
        [key]: {
          status: "failed",
          error: cause instanceof Error ? cause.message : t("connectionFailed"),
        },
      }))
    }
    routeTimers.current[key] = setTimeout(() => {
      delete routeTimers.current[key]
      setRouteTests((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
    }, 3_000)
  }

  const confirmRemove = () => {
    Alert.alert(t("removeHost"), t("removeHostConfirm", { name: host.name }), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("remove"),
        style: "destructive",
        onPress: () => {
          closeRuntime(host.id)
          void removeHost(host.id).then(() => router.replace("/"))
        },
      },
    ])
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.header}>
        <IconButton label={t("back")} onPress={confirmLeave}>
          <Icon name="back" size={22} color={colors.text} />
        </IconButton>
        <Text style={styles.title}>{t("hostSettings")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SectionLabel>{t("name")}</SectionLabel>
        <TextInput
          onChangeText={setName}
          placeholder={t("name")}
          placeholderTextColor={colors.faint}
          style={styles.input}
          value={name}
        />

        <SectionLabel>{t("connectionMethods")}</SectionLabel>
        {routes.length === 0 ? <Text style={styles.hint}>{t("noTransports")}</Text> : null}
        <Card>
          {routes.map((route, index) => {
            const routeTest = routeTests[routeKey(route)]
            return (
            <View key={`${route.kind}-${index}`}>
              {index > 0 ? <Divider inset={16} /> : null}
              <View style={styles.routeRow}>
                <View style={[styles.routeIcon, { backgroundColor: colors.surface2 }]}>
                  <Icon name={route.kind === "relay" ? "globe" : "wifi"} size={16} color={colors.muted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.routeKind}>
                    {route.kind === "relay" ? t("relay") : route.kind === "custom" ? t("custom") : t("direct")}
                  </Text>
                  <Text style={styles.routeUrl} numberOfLines={2}>
                    {route.url}
                  </Text>
                  {route.kind === "relay" ? (
                    <Text style={styles.routeMeta}>
                      {t("room")} {route.room}
                    </Text>
                  ) : null}
                  {routeTest?.status === "ok" ? (
                    <Text style={[styles.routeTestText, { color: colors.success }]}>
                      {t("testOk", { ms: routeTest.ms ?? 0 })}
                    </Text>
                  ) : routeTest?.status === "failed" ? (
                    <Text style={[styles.routeTestText, { color: colors.danger }]} numberOfLines={2}>
                      {routeTest.error ?? t("connectionFailed")}
                    </Text>
                  ) : null}
                </View>
                <IconButton
                  label={t("testConnection")}
                  disabled={routeTest?.status === "testing"}
                  onPress={() => void test(route)}
                >
                  {routeTest?.status === "testing" ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <Icon
                      name="bolt"
                      size={17}
                      color={
                        routeTest?.status === "ok"
                          ? colors.success
                          : routeTest?.status === "failed"
                            ? colors.danger
                            : colors.faint
                      }
                    />
                  )}
                </IconButton>
                <IconButton
                  label={t("removeTransport")}
                  onPress={() => setRoutes((current) => current.filter((_, item) => item !== index))}
                >
                  <Icon name="trash" size={17} color={colors.faint} />
                </IconButton>
              </View>
            </View>
            )
          })}
        </Card>

        <View style={{ marginTop: 10 }}>
          <Button label={t("addConnection")} size="sm" variant="outline" onPress={() => setAddOpen(true)} />
        </View>

        {relayRoom ? (
          <RelayAccessCard key={relayRoom} room={relayRoom} url={relayUrl} compact />
        ) : null}

        {formError ? <Text style={styles.error}>{formError}</Text> : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16 }}>
          <Button
            label={busy ? t("loading") : t("save")}
            size="sm"
            disabled={busy || !dirty || !trimmedName}
            onPress={() => void save()}
          />
        </View>

        <SectionLabel>{t("hostFingerprint")}</SectionLabel>
        <Card style={{ padding: 16 }}>
          <Text style={styles.fingerprint}>{formatFingerprint(host.fingerprint)}</Text>
          <Text style={styles.hint}>{t("verifyFingerprint")}</Text>
        </Card>

        <Card style={{ marginTop: 28, borderColor: colors.danger, padding: 16, gap: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: colors.danger }}>{t("removeHost")}</Text>
          <Text style={styles.hint}>{t("removeHostBody")}</Text>
          <View style={{ marginTop: 8, alignSelf: "flex-start" }}>
            <Button label={t("removeHostAction")} size="sm" variant="danger" onPress={confirmRemove} />
          </View>
        </Card>
      </ScrollView>

      <TransportAddSheet
        visible={addOpen}
        existing={routes}
        onClose={() => setAddOpen(false)}
        onAdd={(transport) => {
          if (routes.some((route) => route.kind === transport.kind && route.url === transport.url && (transport.kind !== "relay" || route.kind !== "relay" || route.room === transport.room))) {
            return false
          }
          setRoutes((current) =>
            [...current, transport]
              .sort((left, right) => (left.kind === "relay" ? 1 : 0) - (right.kind === "relay" ? 1 : 0))
              .map((route, index) => ({ ...route, priority: index })),
          )
          setFormError(null)
          return true
        }}
      />
    </KeyboardAvoidingView>
  )
}

function routeKey(route: Transport): string {
  return `${route.kind}|${route.url}|${route.kind === "relay" ? route.room : ""}`
}

function routeSignature(routes: Transport[]): string {
  return routes.map((route) => routeKey(route)).join("\n")
}

function formatFingerprint(value: string): string {
  return value.toUpperCase().match(/.{1,4}/gu)?.join(" ") ?? value.toUpperCase()
}

const editStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 8,
      paddingBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    title: { fontSize: 17, fontWeight: "700", color: colors.text },
    content: { paddingHorizontal: 16, paddingBottom: 44 },
    input: {
      alignSelf: "stretch",
      minHeight: 42,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      fontSize: 14,
      color: colors.text,
    },
    hint: { fontSize: 11.5, lineHeight: 17, color: colors.faint },
    routeRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
    routeIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    routeKind: { fontSize: 13.5, fontWeight: "600", color: colors.text },
    routeUrl: { fontSize: 11.5, color: colors.muted, marginTop: 2, fontFamily: "monospace" },
    routeMeta: { fontSize: 11, color: colors.faint, marginTop: 2 },
    formLabel: { fontSize: 11.5, fontWeight: "600", color: colors.faint },
    error: { fontSize: 12.5, color: colors.danger, marginTop: 8 },
    routeTestText: { fontSize: 10.5, lineHeight: 15, marginTop: 3 },
    fingerprint: { fontSize: 17, fontWeight: "700", letterSpacing: 1.4, color: colors.text },
    emptyTitle: { fontSize: 19, fontWeight: "600", color: colors.text },
  })
