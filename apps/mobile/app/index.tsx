import { router } from "expo-router"
import { useEffect } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { EmptyState, IconButton } from "@/components/ui"
import { useT } from "@/i18n"
import { useConnections, type HostConnection } from "@/stores/connections"
import { useHosts, type HostRecord } from "@/stores/hosts"
import { usePreferences } from "@/stores/preferences"
import { relativeTime } from "@/lib/time"
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
          <Text style={styles.subtitle}>{t("encrypted")}</Text>
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
  const transport = connection?.transport ?? host.lastTransport

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${host.name}，${status.label}`}
      onPress={() => router.push({ pathname: "/hosts/[hostId]", params: { hostId: host.id } })}
      onLongPress={() => router.push({ pathname: "/hosts/[hostId]/edit", params: { hostId: host.id } })}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
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
      <Icon name="chevronRight" size={17} color={colors.faint} />
    </Pressable>
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
    subtitle: { marginTop: 2, fontSize: 11.5, color: colors.faint },
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
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 15,
      marginBottom: 10,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
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
