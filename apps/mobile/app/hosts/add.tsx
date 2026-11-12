import { parsePairingOffer, type PairingOffer } from "@ocremote/protocol"
import { router } from "expo-router"
import { useState } from "react"
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { useHosts } from "@/stores/hosts"
import { colors, radius, spacing } from "@/theme"

export default function AddHostScreen() {
  const insets = useSafeAreaInsets()
  const addHost = useHosts((state) => state.addHost)
  const [url, setUrl] = useState("")
  const [offer, setOffer] = useState<PairingOffer | null>(null)
  const [error, setError] = useState<string | null>(null)

  const parse = () => {
    try {
      setOffer(parsePairingOffer(url))
      setError(null)
    } catch (cause) {
      setOffer(null)
      setError(cause instanceof Error ? cause.message : "无效的配对链接")
    }
  }

  const add = () => {
    if (!offer) return
    addHost(offer, url.trim())
    router.replace("/")
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Button label="返回" variant="outline" onPress={() => router.back()} />
        <Text style={styles.title}>添加主机</Text>
        <View style={styles.spacer} />
      </View>

      <Text style={styles.label}>配对链接</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
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
          <Text style={styles.previewTitle}>{offer.name}</Text>
          <Text style={styles.previewMeta}>指纹 {offer.fingerprint}</Text>
          <Text style={styles.previewMeta}>{offer.transports.length} 个连接方式</Text>
          <Text style={styles.previewMeta}>过期 {new Date(offer.expiresAt).toLocaleTimeString()}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {offer ? <Button label="确认添加" onPress={add} /> : <Button label="解析链接" onPress={parse} />}
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.xl },
  title: { fontSize: 20, fontWeight: "600", color: colors.text },
  spacer: { width: 72 },
  label: { fontSize: 13, fontWeight: "500", color: colors.muted, marginBottom: spacing.sm },
  input: {
    minHeight: 112,
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
  error: { marginTop: spacing.md, fontSize: 13, color: colors.danger },
  preview: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
  },
  previewTitle: { fontSize: 17, fontWeight: "600", color: colors.text },
  previewMeta: { marginTop: 4, fontSize: 13, color: colors.muted },
  actions: { marginTop: spacing.xl },
})
