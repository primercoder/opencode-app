import { parseRelayInviteLink } from "@ocremote/protocol"
import { useEffect, useState } from "react"
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native"
import { Button, Card } from "@/components/ui"
import { useT } from "@/i18n"
import { enrollRelayClient, RelayAccessError, type RelayEnrollment } from "@/services/relay"
import { loadRelayAccess, normalizeRelayUrl } from "@/storage/relay"
import { useTheme, type Palette } from "@/theme"

export function RelayAccessCard(props: {
  room: string
  url?: string
  onEnrolled?: (enrollment: RelayEnrollment) => void
  compact?: boolean
}) {
  const { colors } = useTheme()
  const t = useT()
  const styles = stylesFor(colors)
  const [link, setLink] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrolled, setEnrolled] = useState<RelayEnrollment | null>(null)

  useEffect(() => {
    if (!props.url) return
    let cancelled = false
    void loadRelayAccess(props.url)
      .then((access) => {
        if (!cancelled && access) setEnrolled({ url: normalizeRelayUrl(props.url ?? ""), access })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [props.url, props.room])

  useEffect(() => {
    if (!props.room) return
    let cancelled = false
    void (async () => {
      if (!link.trim()) return
      try {
        const invite = parseRelayInviteLink(link)
        const access = await loadRelayAccess(invite.url)
        if (!cancelled && access) {
          setEnrolled({ url: normalizeRelayUrl(invite.url), access })
        }
      } catch {
        // The link is still being typed.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [link, props.room])

  const enroll = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await enrollRelayClient({ link, room: props.room })
      setEnrolled(result)
      setLink("")
      props.onEnrolled?.(result)
    } catch (cause) {
      setError(
        cause instanceof RelayAccessError
          ? relayErrorMessage(cause, t)
          : cause instanceof Error
            ? cause.message
            : t("error"),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card style={{ padding: props.compact ? 12 : 14, gap: 8, marginTop: 10 }}>
      <Text style={styles.title}>{t("relayAccessTitle")}</Text>
      <Text style={styles.hint}>{t("relayAccessHint")}</Text>
      {enrolled ? (
        <View style={styles.status}>
          <Text style={styles.ok}>{t("relayEnrolled")}</Text>
          <Text style={styles.subject} numberOfLines={1}>
            {normalizeRelayUrl(enrolled.url)} · {enrolled.access.subjectId}
          </Text>
        </View>
      ) : null}
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        multiline
        onChangeText={(value) => {
          setLink(value)
          setError(null)
        }}
        placeholder={t("relayAccessPlaceholder")}
        placeholderTextColor={colors.faint}
        style={styles.input}
        value={link}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        <Button
          label={busy ? t("relayEnrolling") : t("relayEnroll")}
          size="sm"
          disabled={busy || !link.trim() || !props.room}
          onPress={() => void enroll()}
        />
      </View>
    </Card>
  )
}

function relayErrorMessage(error: RelayAccessError, t: ReturnType<typeof useT>): string {
  switch (error.code) {
    case "RELAY_INVITE_CONSUMED":
      return "这个邀请已经被使用，请让管理员生成新的手机邀请。"
    case "RELAY_INVITE_EXPIRED":
      return "邀请已过期，请让管理员生成新的手机邀请。"
    case "RELAY_INVITE_INVALID":
      return "邀请链接无效，请确认复制的是手机邀请。"
    case "RELAY_ROOM_NOT_FOUND":
      return "中继上找不到这台主机的房间，请重新扫描主机配对码。"
    case "RELAY_NETWORK":
    case "RELAY_TIMEOUT":
      return "无法连接中继，请检查地址和网络。"
    default:
      return error.message || t("error")
  }
}

const stylesFor = (colors: Palette) =>
  StyleSheet.create({
    title: { fontSize: 13.5, fontWeight: "700", color: colors.text },
    hint: { fontSize: 11.5, lineHeight: 17, color: colors.faint },
    input: {
      minHeight: 64,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.surface,
      padding: 10,
      fontSize: 12,
      lineHeight: 18,
      color: colors.text,
      textAlignVertical: "top",
    },
    status: { gap: 2 },
    ok: { fontSize: 12.5, color: colors.success, fontWeight: "600" },
    subject: { fontSize: 11, color: colors.faint },
    error: { fontSize: 12, lineHeight: 17, color: colors.danger },
    actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 10 },
  })
