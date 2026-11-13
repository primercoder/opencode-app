import { router } from "expo-router"
import { useEffect } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { Button, EmptyState, IconButton } from "@/components/ui"
import { useT } from "@/i18n"
import { useConnections, type HostConnection } from "@/stores/connections"
import { useHosts, type HostRecord } from "@/stores/hosts"
import { usePreferences } from "@/stores/preferences"
import { relativeTime } from "@/lib/time"
import { closeRuntime, ensureConnection } from "@/transport/runtimes"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

export default function HostListScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const language = usePreferences((state) => state.language)
  const styles = useThemedStyles(homeStyles)
  const hosts = useHosts((state) => state.hosts)
  const hydrate = useHosts((state) => state.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{t("appName")}</Text>
        </View>
        <View style={styles.headerActions}>
          <IconButton label={t("settings")} onPress={() => router.push("/settings")}>
            <Icon name="settings" size={22} color={colors.text} />
          </IconButton>
          <IconButton label={t("addHost")} onPress={() => router.push("/hosts/add")}>
            <Icon name="plus" size={23} color={colors.accent} />
          </IconButton>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {hosts.length === 0 ? (
          <EmptyState
            icon={<Icon name="server" size={38} color={colors.faint} />}
            title={t("noHosts")}
            body={t("noHostsBody")}
          />
        ) : (
          <>
            <Text style={styles.sectionLabel}>
              {(hosts.length === 1 ? t("hostCountOne") : t("hostCount", { n: hosts.length })).toUpperCase()}
            </Text>
            {hosts.map((host) => (
              <HostRow key={host.id} host={host} language={language} />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  )
}

function HostRow({ host, language }: { host: HostRecord; language: "zh" | "en" }) {
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(homeStyles)
  const connection = useConnections((state) => state.byHost[host.id])
  const status = statusOf(connection, t)
  const transport = connection?.transport ?? host.transports[0]?.kind ?? host.lastTransport
  const ready = connection?.status === "ready"
  const connecting =
    connection?.status === "connecting" ||
    connection?.status === "handshaking" ||
    connection?.status === "authenticating" ||
    connection?.status === "reconnecting"

  const open = () => router.push({ pathname: "/hosts/[hostId]", params: { hostId: host.id } })
  const connect = async () => {
    if (connecting) return
    if (ready) {
      open()
      return
    }
    try {
      await ensureConnection(host.id, { force: true })
      open()
    } catch {
      // The row keeps the error from the connection store and stays on this page.
    }
  }
  const disconnect = () => closeRuntime(host.id)

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${host.name}，${status.label}`}
        onPress={() => void connect()}
        style={({ pressed }) => [styles.cardMain, pressed && { opacity: 0.7 }]}
      >
        <View style={[styles.statusDot, { backgroundColor: status.color }]} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {host.name}
            </Text>
            <View style={styles.transportBadge}>
              <Text style={styles.transportText}>{transportLabel(transport, t)}</Text>
            </View>
          </View>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {status.label}
            {connection?.error ? ` · ${connection.error.message}` : ""}
            {!connection && host.lastConnectedAt
              ? ` · ${relativeTime(host.lastConnectedAt, language)}`
              : ""}
          </Text>
        </View>
      </Pressable>
      <IconButton
        label={t("hostSettings")}
        onPress={() => router.push({ pathname: "/hosts/[hostId]/edit", params: { hostId: host.id } })}
      >
        <Icon name="settings" size={18} color={colors.faint} />
      </IconButton>
      {ready ? (
        <Button label={t("disconnectAction")} size="sm" variant="outline" onPress={disconnect} style={{ borderColor: colors.danger }} />
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={connecting}
          onPress={() => void connect()}
          style={({ pressed }) => [
            styles.connectButton,
            { backgroundColor: connecting ? colors.surface2 : colors.accent },
            pressed && { opacity: 0.75 },
          ]}
        >
          {connecting ? <ActivityIndicator size="small" color={colors.muted} /> : null}
          <Text style={{ fontSize: 12.5, fontWeight: "700", color: connecting ? colors.muted : colors.accentText }}>
            {connecting ? t("connectingAction") : t("connectAction")}
          </Text>
        </Pressable>
      )}
    </View>
  )
}

function statusOf(connection: HostConnection | undefined, t: ReturnType<typeof useT>): { label: string; color: string } {
  if (!connection || connection.status === "idle") return { label: t("notConnected"), color: "#8A94A3" }
  switch (connection.status) {
    case "connecting":
    case "handshaking":
    case "authenticating":
    case "reconnecting":
      return { label: t("connecting"), color: "#2F6BFF" }
    case "ready":
      return { label: t("connected"), color: "#168A4A" }
    case "error":
      return { label: t("connectionFailed"), color: "#D92E3C" }
    case "closed":
      return { label: t("offline"), color: "#8A94A3" }
    default:
      return { label: t("notConnected"), color: "#8A94A3" }
  }
}

function transportLabel(transport: string | undefined, t: ReturnType<typeof useT>): string {
  if (transport === "relay") return t("relay")
  if (transport === "custom") return t("custom")
  if (transport === "lan") return t("direct")
  return t("notConnected")
}

const homeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingBottom: 14,
      paddingLeft: 4,
    },
    title: { fontSize: 28, fontWeight: "700", letterSpacing: -0.4, color: colors.text },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 2 },
    content: { paddingBottom: 40 },
    sectionLabel: {
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.8,
      color: colors.faint,
      marginBottom: 8,
      paddingLeft: 4,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 10,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    cardMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 3 },
    connectButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 36,
      paddingHorizontal: 14,
      borderRadius: 999,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    cardTitle: { fontSize: 16, fontWeight: "600", color: colors.text, flexShrink: 1 },
    cardMeta: { marginTop: 4, fontSize: 12, color: colors.muted },
    transportBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: colors.surface2,
    },
    transportText: { fontSize: 10.5, fontWeight: "600", color: colors.muted },
  })
