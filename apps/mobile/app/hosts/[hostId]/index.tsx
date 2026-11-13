import { router, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { Button, Card, Divider, IconButton } from "@/components/ui"
import { useT } from "@/i18n"
import { useConnections } from "@/stores/connections"
import { useHosts } from "@/stores/hosts"
import { ensureConnection, refreshInfo } from "@/transport/runtimes"
import { useForeground } from "@/lib/useForeground"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

export default function HostHomeScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(hostStyles)
  const params = useLocalSearchParams<{ hostId: string }>()
  const hostId = params.hostId
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const connection = useConnections((state) => (hostId ? state.byHost[hostId] : undefined))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  useEffect(() => {
    if (!hydrated) {
      void hydrate()
      return
    }
    if (!host) return
    void ensureConnection(host.id).catch(() => undefined)
  }, [hydrated, host?.id, hydrate])

  useForeground(
    useCallback(() => {
      if (!host) return
      void ensureConnection(host.id, { force: true })
        .then(() => refreshInfo(host.id))
        .catch(() => undefined)
    }, [host?.id]),
  )

  if (!hydrated) return <View style={styles.screen} />

  if (!host) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 40, alignItems: "center" }]}>
        <Text style={styles.heroTitle}>{t("hostMissing")}</Text>
        <Text style={styles.heroBody}>{t("hostMissingBody")}</Text>
        <View style={{ marginTop: 20 }}>
          <Button label={t("backToHosts")} onPress={() => router.replace("/")} />
        </View>
      </View>
    )
  }

  const status = connection?.status ?? "idle"
  const ready = status === "ready"
  const connecting = status === "connecting" || status === "handshaking" || status === "authenticating" || status === "reconnecting"
  const retry = () => {
    setRefreshError(null)
    void ensureConnection(host.id, { force: true }).catch(() => undefined)
  }
  const refresh = async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      if (!ready) await ensureConnection(host.id, { force: true })
      await refreshInfo(host.id)
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : t("error"))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <IconButton label={t("back")} onPress={() => router.replace("/")}>
          <Icon name="back" size={22} color={colors.text} />
        </IconButton>
        <View style={styles.headerCenter}>
          <Text style={styles.hostName} numberOfLines={1}>
            {host.name}
          </Text>
          <View style={styles.statusLine}>
            <View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
            <Text style={styles.subtitle}>{statusLabel(status, t)}</Text>
          </View>
        </View>
        <IconButton
          label={t("hostSettings")}
          onPress={() => router.push({ pathname: "/hosts/[hostId]/edit", params: { hostId: host.id } })}
        >
          <Icon name="settings" size={21} color={colors.text} />
        </IconButton>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.muted} />}
      >
        <Card style={{ padding: 20, alignItems: "center", gap: 8 }}>
          <View style={[styles.heroIcon, { backgroundColor: colors.accentSoft }]}>
            <Icon name="server" size={26} color={colors.accent} />
          </View>
          <Text style={styles.heroTitle}>
            {ready ? t("connected") : connecting ? t("connecting") : t("offline")}
          </Text>
          <Text style={styles.heroBody}>
            {ready
              ? t("encrypted")
              : status === "error"
                ? connection?.error?.message ?? t("hostOfflineBody")
                : t("hostOfflineBody")}
          </Text>
          {status === "error" ? (
            <View style={{ marginTop: 6 }}>
              <Button label={t("retry")} size="sm" onPress={retry} />
            </View>
          ) : null}
        </Card>

        <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
          <View style={{ flex: 1 }}>
            <Button
              label={t("openSession")}
              disabled={!ready}
              onPress={() => router.push({ pathname: "/hosts/[hostId]/sessions", params: { hostId: host.id } })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label={t("newSession")}
              variant="outline"
              disabled={!ready || connection?.session?.device?.scope === "read"}
              onPress={() =>
                router.push({ pathname: "/hosts/[hostId]/sessions", params: { hostId: host.id, new: "1" } })
              }
            />
          </View>
        </View>

        {refreshError ? <Text style={styles.error}>{refreshError}</Text> : null}

        <Card style={{ marginTop: 18 }}>
          <InfoRow label={t("version")} value={`opencode ${connection?.session?.opencode.version ?? (ready ? "2.x" : "—")}`} />
          <Divider inset={16} />
          <InfoRow label={t("connection")} value={transportLabel(connection?.transport, t)} />
          <Divider inset={16} />
          <InfoRow label={t("latency")} value={connection?.latencyMs !== undefined ? `${connection.latencyMs} ms` : "—"} />
          <Divider inset={16} />
          <InfoRow
            label={t("devicePermissions")}
            value={connection?.session?.device?.scope === "read" ? t("readOnly") : t("fullAccess")}
          />
          <Divider inset={16} />
          <InfoRow label={t("hostFingerprint")} value={formatFingerprint(host.fingerprint)} mono />
        </Card>

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 22 }}>
          <Icon name="lock" size={12} color={colors.faint} />
          <Text style={{ fontSize: 11, color: colors.faint }}>{t("securityNote")}</Text>
        </View>
      </ScrollView>
    </View>
  )
}

function InfoRow(props: { label: string; value: string; mono?: boolean }) {
  const styles = useThemedStyles(hostStyles)
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{props.label}</Text>
      <Text style={[styles.infoValue, props.mono && styles.infoValueMono]} numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  )
}

function statusColor(status: string): string {
  if (status === "ready") return "#168A4A"
  if (status === "error") return "#D92E3C"
  if (status === "connecting" || status === "handshaking" || status === "authenticating" || status === "reconnecting") {
    return "#2F6BFF"
  }
  return "#8A94A3"
}

function statusLabel(status: string, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "ready":
      return t("connected")
    case "error":
      return t("offline")
    case "connecting":
    case "handshaking":
    case "authenticating":
      return t("connecting")
    case "reconnecting":
      return t("reconnecting")
    default:
      return t("notConnected")
  }
}

function transportLabel(transport: string | undefined, t: ReturnType<typeof useT>): string {
  if (transport === "lan") return t("direct")
  if (transport === "relay") return t("relay")
  if (transport === "custom") return t("custom")
  return "—"
}

function formatFingerprint(value: string): string {
  return value.toUpperCase().match(/.{1,4}/gu)?.join(" ") ?? value.toUpperCase()
}

const hostStyles = (colors: Palette) =>
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
    hostName: { fontSize: 16, fontWeight: "700", color: colors.text },
    statusLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    subtitle: { fontSize: 11, color: colors.muted },
    content: { padding: 16, paddingBottom: 40 },
    heroIcon: { width: 52, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", marginBottom: 2 },
    heroTitle: { fontSize: 19, fontWeight: "700", color: colors.text },
    heroBody: { fontSize: 13, lineHeight: 20, color: colors.muted, textAlign: "center", maxWidth: 300 },
    infoRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 13,
      gap: 16,
    },
    infoLabel: { fontSize: 13, color: colors.muted },
    infoValue: { flex: 1, textAlign: "right", fontSize: 13.5, color: colors.text, fontWeight: "500" },
    infoValueMono: { fontSize: 11.5, letterSpacing: 0.6, fontFamily: "monospace" },
    error: { marginTop: 12, fontSize: 12.5, color: colors.danger, textAlign: "center" },
  })
