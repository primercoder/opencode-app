import { router, useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import { useHosts } from "@/stores/hosts"
import { ensureConnection } from "@/transport/runtimes"
import { colors, radius, spacing } from "@/theme"

export default function EditHostScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId: string }>()
  const hostId = params.hostId
  const hydrate = useHosts((state) => state.hydrate)
  const hydrated = useHosts((state) => state.hydrated)
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId))
  const renameHost = useHosts((state) => state.renameHost)
  const removeHost = useHosts((state) => state.removeHost)
  const [name, setName] = useState(host?.name ?? "")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testFailed, setTestFailed] = useState(false)

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  useEffect(() => {
    if (host) setName(host.name)
  }, [host?.id, host?.name])

  if (!hydrated) return <View style={styles.screen} />

  if (!host) {
    return (
      <View style={[styles.screen, styles.centered, { paddingTop: insets.top }]}>
        <Text style={styles.emptyTitle}>主机不存在</Text>
        <View style={styles.emptyAction}>
          <Button label="返回" onPress={() => router.replace("/")} />
        </View>
      </View>
    )
  }

  const save = async () => {
    setSaving(true)
    try {
      await renameHost(host.id, name)
      Alert.alert("已保存", "主机名称已更新。")
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    setTestFailed(false)
    const startedAt = Date.now()
    try {
      const runtime = await ensureConnection(host.id, { force: true })
      const response = await runtime.request({ method: "GET", path: "/api/info", timeoutMs: 8_000 })
      if (response.status !== 200) throw new Error(`opencode 返回 HTTP ${response.status}`)
      setTestResult(`连接成功 · ${Date.now() - startedAt} ms`)
    } catch (cause) {
      setTestFailed(true)
      setTestResult(cause instanceof Error ? cause.message : "连接失败")
    } finally {
      setTesting(false)
    }
  }

  const confirmRemove = () => {
    Alert.alert("移除主机", `移除“${host.name}”？本机保存的设备令牌也会删除，但不会撤销主机端授权。`, [
      { text: "取消", style: "cancel" },
      {
        text: "移除",
        style: "destructive",
        onPress: () => {
          void removeHost(host.id).then(() => router.replace("/"))
        },
      },
    ])
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + spacing.md }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.title}>主机设置</Text>
        <View style={styles.back} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.label}>名称</Text>
        <View style={styles.nameRow}>
          <TextInput
            onChangeText={setName}
            placeholder="主机名称"
            placeholderTextColor={colors.faint}
            style={styles.input}
            value={name}
          />
          <Button label={saving ? "保存中…" : "保存"} onPress={() => void save()} disabled={saving || name.trim() === host.name} />
        </View>

        <Text style={styles.label}>主机指纹</Text>
        <View style={styles.card}>
          <Text style={styles.fingerprint}>{formatFingerprint(host.fingerprint)}</Text>
          <Text style={styles.hint}>请与电脑上显示的指纹核对。指纹不一致时不要连接。</Text>
        </View>

        <Text style={styles.label}>连接方式</Text>
        <View style={styles.card}>
          {host.transports.map((transport, index) => (
            <View key={`${transport.kind}-${index}`} style={[styles.transport, index > 0 && styles.transportBorder]}>
              <View style={styles.transportHeader}>
                <Text style={styles.transportKind}>{transportLabel(transport.kind)}</Text>
                <Text style={styles.transportPriority}>优先级 {transport.priority}</Text>
              </View>
              <Text style={styles.transportUrl} numberOfLines={2}>
                {transport.url}
              </Text>
              {transport.kind === "relay" ? <Text style={styles.transportMeta}>房间 {transport.room}</Text> : null}
            </View>
          ))}
        </View>

        <View style={styles.testRow}>
          <Button label={testing ? "测试中…" : "测试连接"} variant="outline" onPress={() => void test()} disabled={testing} />
          {testResult ? <Text style={[styles.testResult, testFailed && styles.testFailed]}>{testResult}</Text> : null}
        </View>

        <Text style={styles.security}>
          设备令牌保存在 Android 系统安全存储中。撤销授权请在电脑上运行 `ocremote devices revoke &lt;id&gt;`。
        </Text>

        <View style={styles.dangerZone}>
          <Text style={styles.dangerTitle}>移除主机</Text>
          <Text style={styles.dangerBody}>删除本机的主机记录和设备令牌，不会撤销主机端授权。</Text>
          <View style={styles.dangerAction}>
            <Button label="移除这台主机" variant="outline" onPress={confirmRemove} />
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function transportLabel(kind: string): string {
  if (kind === "lan") return "局域网"
  if (kind === "relay") return "中继"
  return "自定义"
}

function formatFingerprint(value: string): string {
  return value.toUpperCase().match(/.{1,4}/gu)?.join(" ") ?? value.toUpperCase()
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  centered: { alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: spacing.lg },
  back: { width: 64 },
  backText: { fontSize: 15, color: colors.muted },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  content: { paddingBottom: spacing.xxl },
  label: { marginTop: spacing.lg, marginBottom: spacing.sm, fontSize: 12, fontWeight: "600", color: colors.muted },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.text,
  },
  card: {
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  fingerprint: { fontSize: 17, fontWeight: "600", letterSpacing: 1.4, color: colors.text },
  hint: { fontSize: 12, lineHeight: 18, color: colors.faint },
  transport: { gap: 3, paddingVertical: spacing.xs },
  transportBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.md },
  transportHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  transportKind: { fontSize: 14, fontWeight: "600", color: colors.text },
  transportPriority: { fontSize: 11, color: colors.faint },
  transportUrl: { fontSize: 12, color: colors.muted, fontFamily: "monospace" },
  transportMeta: { fontSize: 11, color: colors.faint, fontFamily: "monospace" },
  testRow: { marginTop: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md, flexWrap: "wrap" },
  testResult: { flex: 1, fontSize: 12, color: colors.success },
  testFailed: { color: colors.danger },
  security: { marginTop: spacing.xl, fontSize: 12, lineHeight: 18, color: colors.faint },
  dangerZone: {
    marginTop: spacing.xxl,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(217,46,60,0.25)",
    backgroundColor: "rgba(217,46,60,0.04)",
    gap: spacing.sm,
  },
  dangerTitle: { fontSize: 15, fontWeight: "600", color: colors.danger },
  dangerBody: { fontSize: 12, lineHeight: 18, color: colors.muted },
  dangerAction: { marginTop: spacing.sm, alignItems: "flex-start" },
  emptyTitle: { fontSize: 20, fontWeight: "500", color: colors.text },
  emptyAction: { marginTop: spacing.xl },
})
