import { parsePairingOffer, type PairingOffer } from "@ocremote/protocol"
import { router } from "expo-router"
import { useState } from "react"
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { pairWithOffer, type PairingStage } from "@/services/pairing"
import { HostError } from "@/transport/hostRuntime"
import { colors, radius, spacing } from "@/theme"

const stageLabels: Record<PairingStage, string> = {
  connecting: "正在连接主机…",
  handshaking: "正在建立加密通道…",
  authenticating: "正在验证主机…",
  saving: "正在保存设备…",
}

export default function AddHostScreen() {
  const insets = useSafeAreaInsets()
  const [url, setUrl] = useState("")
  const [offer, setOffer] = useState<PairingOffer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<PairingStage | null>(null)

  const busy = stage !== null

  const parse = () => {
    try {
      setOffer(parsePairingOffer(url))
      setError(null)
    } catch (cause) {
      setOffer(null)
      setError(cause instanceof Error ? cause.message : "无效的配对链接")
    }
  }

  const pair = async () => {
    if (!offer) return
    setError(null)
    try {
      const { host } = await pairWithOffer(offer, setStage)
      router.replace({ pathname: "/hosts/[hostId]", params: { hostId: host.id } })
    } catch (cause) {
      const failure = cause instanceof HostError ? cause : null
      setError(pairingMessage(failure))
    } finally {
      setStage(null)
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Button label="返回" variant="outline" onPress={() => router.back()} disabled={busy} />
        <Text style={styles.title}>添加主机</Text>
        <View style={styles.spacer} />
      </View>

      <Text style={styles.label}>配对链接</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        multiline
        onChangeText={(value) => {
          setUrl(value)
          setOffer(null)
          setError(null)
        }}
        placeholder="ocremote://pair#..."
        placeholderTextColor={colors.faint}
        style={styles.input}
        value={url}
      />
      <Text style={styles.hint}>
        在电脑上运行 `ocremote pair --lan`，扫码或粘贴链接。链接一次性有效，过期后重新生成。
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {offer ? (
        <View style={styles.preview}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle}>{offer.name}</Text>
            <Text style={styles.badge}>{offer.transports.length} 条线路</Text>
          </View>
          <Text style={styles.previewLabel}>主机指纹</Text>
          <Text style={styles.fingerprint}>{formatFingerprint(offer.fingerprint)}</Text>
          <Text style={styles.previewMeta}>请与电脑上显示的指纹核对。</Text>
          <Text style={styles.previewMeta}>配对码 {offer.pairCode} · 有效期至 {new Date(offer.expiresAt).toLocaleTimeString()}</Text>
          <Text style={styles.security}>中继只能转发密文，无法读取你的代码或对话。</Text>
        </View>
      ) : null}

      {stage ? (
        <View style={styles.stage}>
          <Text style={styles.stageDot}>●</Text>
          <Text style={styles.stageText}>{stageLabels[stage]}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {offer ? (
          <Button label={busy ? "配对中…" : "连接并配对"} onPress={() => void pair()} disabled={busy} />
        ) : (
          <Button label="解析链接" onPress={parse} disabled={busy || url.trim().length === 0} />
        )}
      </View>
    </KeyboardAvoidingView>
  )
}

function pairingMessage(error: HostError | null): string {
  if (!error) return "配对失败，请重试"
  if (error.code === "PAIR_CODE_INVALID") return "配对码无效或已过期，请在电脑上重新生成。"
  if (error.kind === "auth") return `认证失败：${error.message}`
  if (error.kind === "network" || error.kind === "timeout") return "无法连接主机，请确认手机与电脑在同一局域网，且主机已启动。"
  if (error.kind === "protocol") return `协议错误：${error.message}`
  return error.message
}

function formatFingerprint(value: string): string {
  return value.toUpperCase().match(/.{1,4}/gu)?.join(" ") ?? value.toUpperCase()
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.xl },
  title: { fontSize: 20, fontWeight: "600", color: colors.text },
  spacer: { width: 72 },
  label: { fontSize: 13, fontWeight: "500", color: colors.muted, marginBottom: spacing.sm },
  input: {
    minHeight: 104,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
    textAlignVertical: "top",
  },
  hint: { marginTop: spacing.sm, fontSize: 12, lineHeight: 18, color: colors.faint },
  error: { marginTop: spacing.md, fontSize: 13, lineHeight: 19, color: colors.danger },
  preview: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  previewHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  previewTitle: { fontSize: 17, fontWeight: "600", color: colors.text },
  badge: { fontSize: 12, color: colors.accent, fontWeight: "500" },
  previewLabel: { fontSize: 12, color: colors.faint, marginBottom: 2 },
  fingerprint: { fontSize: 18, fontWeight: "600", letterSpacing: 1.5, color: colors.text, marginBottom: spacing.sm },
  previewMeta: { marginTop: 3, fontSize: 13, color: colors.muted },
  security: { marginTop: spacing.md, fontSize: 12, lineHeight: 18, color: colors.faint },
  stage: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  stageDot: { color: colors.accent, fontSize: 12 },
  stageText: { fontSize: 14, color: colors.text },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
})
