import { formatModelSize } from "@ocremote/models"
import * as DocumentPicker from "expo-document-picker"
import { router } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button } from "@/components/Button"
import {
  downloadMobileModel,
  importMobileModel,
  listMobileModels,
  loadModelServer,
  mobileModelBaseUrl,
  removeMobileModel,
  saveModelServer,
  selectMobileModel,
  type DownloadProgress,
  type MobileModelStatus,
} from "@/features/voice/models"
import { ensureWhisperModel, transcribeFile } from "@/features/voice/localWhisper"
import {
  loadVoiceEnginePreference,
  saveVoiceEnginePreference,
  type VoiceEnginePreference,
} from "@/features/voice/preferences"
import { colors, radius, spacing } from "@/theme"

export default function SettingsScreen() {
  const insets = useSafeAreaInsets()
  const [models, setModels] = useState<MobileModelStatus[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, DownloadProgress | undefined>>({})
  const [error, setError] = useState<string | null>(null)
  const [testText, setTestText] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState("")
  const [effectiveServer, setEffectiveServer] = useState<string | undefined>(undefined)
  const [serverSaved, setServerSaved] = useState(false)
  const [enginePreference, setEnginePreference] = useState<VoiceEnginePreference>("auto")

  const reload = useCallback(async () => {
    setModels(await listMobileModels())
  }, [])

  useEffect(() => {
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : "读取模型列表失败"))
    void loadModelServer().then(setServerUrl).catch(() => undefined)
    void mobileModelBaseUrl().then(setEffectiveServer).catch(() => undefined)
    void loadVoiceEnginePreference().then(setEnginePreference).catch(() => undefined)
  }, [reload])

  const download = async (model: MobileModelStatus) => {
    setBusy(model.spec.id)
    setError(null)
    setTestText(null)
    try {
      await downloadMobileModel(model.spec, (value) => {
        setProgress((current) => ({ ...current, [model.spec.id]: value }))
      })
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型下载失败")
    } finally {
      setProgress((current) => ({ ...current, [model.spec.id]: undefined }))
      setBusy(null)
    }
  }

  const importModel = async (model: MobileModelStatus) => {
    setBusy(model.spec.id)
    setError(null)
    try {
      await importMobileModel(model.spec)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型导入失败")
    } finally {
      setBusy(null)
    }
  }

  const remove = async (model: MobileModelStatus) => {
    setBusy(model.spec.id)
    setError(null)
    try {
      await removeMobileModel(model.spec)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除模型失败")
    } finally {
      setBusy(null)
    }
  }

  const select = async (model: MobileModelStatus) => {
    await selectMobileModel(model.spec.id)
    await reload()
  }

  const test = async (model: MobileModelStatus) => {
    if (!model.path) return
    setBusy(model.spec.id)
    setError(null)
    setTestText(null)
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["audio/wav", "audio/*", "*/*"],
        copyToCacheDirectory: true,
      })
      if (picked.canceled || !picked.assets[0]) return
      await ensureWhisperModel(model.path)
      const text = await transcribeFile(picked.assets[0].uri, "zh")
      setTestText(text || "（没有识别到文字）")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型测试失败")
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.title}>设置</Text>
        <View style={styles.back} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionTitle}>手机语音模型</Text>
        <Text style={styles.sectionBody}>
          模型不会打包进 APK。下载或导入后，听写会优先使用本地模型，输入结果只插入输入框，不会自动发送。
        </Text>
        <Text style={styles.sectionTitle}>听写引擎</Text>
        <Text style={styles.sectionBody}>
          自动：优先手机模型，其次主机模型，最后系统识别。识别结果只插入输入框。
        </Text>
        <View style={styles.engineRow}>
          {(
            [
              ["auto", "自动"],
              ["local", "手机"],
              ["host", "主机"],
              ["system", "系统"],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: enginePreference === value }}
              onPress={() => {
                setEnginePreference(value)
                void saveVoiceEnginePreference(value)
              }}
              style={[styles.engineChip, enginePreference === value && styles.engineChipActive]}
            >
              <Text style={[styles.engineText, enginePreference === value && styles.engineTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.sectionTitle}>模型服务器</Text>
        <Text style={styles.sectionBody}>
          留空使用 release 内置的上游地址；开发或自建镜像可填写本地服务器，例如 http://10.0.2.2:9000。
        </Text>
        <View style={styles.serverRow}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(value) => {
              setServerUrl(value)
              setServerSaved(false)
            }}
            placeholder="https://models.example.com"
            placeholderTextColor={colors.faint}
            style={styles.serverInput}
            value={serverUrl}
          />
          <Button
            label="保存"
            variant="outline"
            onPress={() => {
              void saveModelServer(serverUrl)
                .then(() => mobileModelBaseUrl())
                .then((value) => {
                  setEffectiveServer(value)
                  setServerSaved(true)
                })
                .catch(() => setError("保存模型服务器失败"))
            }}
          />
        </View>
        <Text style={styles.devHint}>
          当前下载源：{effectiveServer ?? "release 上游地址"}
          {serverSaved ? " · 已保存" : ""}
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {models === null ? <ActivityIndicator style={styles.loading} color={colors.accent} /> : null}

        {models?.map((model) => {
          const value = progress[model.spec.id]
          const percent = value?.totalBytes ? Math.min(100, Math.floor((value.receivedBytes / value.totalBytes) * 100)) : 0
          return (
            <View key={model.spec.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Text style={styles.cardTitle}>{model.spec.label}</Text>
                  {model.selected ? <Text style={styles.selected}>已选择</Text> : null}
                </View>
                <Text style={styles.size}>{formatModelSize(model.spec.sizeBytes)}</Text>
              </View>
              <Text style={styles.cardBody}>{model.spec.description}</Text>
              <Text style={styles.languages}>{model.spec.languages.join(" · ")}</Text>
              {value ? (
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${percent}%` }]} />
                  <Text style={styles.progressText}>{percent}%</Text>
                </View>
              ) : null}
              <View style={styles.actions}>
                {model.installed ? (
                  <>
                    <Button
                      label={model.selected ? "已选择" : "使用此模型"}
                      variant={model.selected ? "outline" : "primary"}
                      onPress={() => void select(model)}
                      disabled={busy !== null || model.selected}
                    />
                    <Button label="测试" variant="outline" onPress={() => void test(model)} disabled={busy !== null} />
                    <Button label="删除" variant="outline" onPress={() => void remove(model)} disabled={busy !== null} />
                  </>
                ) : (
                  <>
                    <Button
                      label={busy === model.spec.id ? "下载中…" : "下载"}
                      onPress={() => void download(model)}
                      disabled={busy !== null}
                    />
                    <Button label="从文件导入" variant="outline" onPress={() => void importModel(model)} disabled={busy !== null} />
                  </>
                )}
              </View>
            </View>
          )
        })}

        {testText !== null ? (
          <View style={styles.testCard}>
            <Text style={styles.testLabel}>模型测试结果</Text>
            <Text style={styles.testText}>{testText}</Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>主机语音模型</Text>
        <Text style={styles.sectionBody}>
          主机端使用更大的模型，在电脑上运行 `ocremote asr install host-sense-voice-int8` 下载；手机听写结果仍只进入输入框。
        </Text>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: spacing.lg },
  back: { width: 64 },
  backText: { fontSize: 15, color: colors.muted },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  content: { paddingBottom: spacing.xxl, gap: spacing.md },
  sectionTitle: { marginTop: spacing.sm, fontSize: 15, fontWeight: "600", color: colors.text },
  sectionBody: { fontSize: 13, lineHeight: 20, color: colors.muted },
  devHint: { fontSize: 11, color: colors.faint, fontFamily: "monospace" },
  serverRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  engineRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  engineChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  engineChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  engineText: { fontSize: 13, color: colors.text },
  engineTextActive: { color: "#FFFFFF", fontWeight: "600" },
  serverInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontSize: 13,
    color: colors.text,
  },
  error: { fontSize: 13, color: colors.danger },
  loading: { marginVertical: spacing.lg },
  card: {
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
  selected: { fontSize: 11, color: colors.success, fontWeight: "600" },
  size: { fontSize: 12, color: colors.faint },
  cardBody: { fontSize: 13, lineHeight: 19, color: colors.muted },
  languages: { fontSize: 11, color: colors.faint },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surface2,
    overflow: "hidden",
    marginTop: spacing.xs,
  },
  progressFill: { height: 6, backgroundColor: colors.accent },
  progressText: { position: "absolute", right: 0, top: 9, fontSize: 10, color: colors.faint },
  testCard: {
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  testLabel: { fontSize: 12, fontWeight: "600", color: colors.muted },
  testText: { fontSize: 14, lineHeight: 20, color: colors.text },
})
