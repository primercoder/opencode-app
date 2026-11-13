import { formatModelSize } from "@ocremote/models"
import * as DocumentPicker from "expo-document-picker"
import { router } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { Badge, Button, Card, IconButton, SectionLabel } from "@/components/ui"
import { useT } from "@/i18n"
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
import { ensureWhisperModel, releaseWhisperModel, transcribeFile } from "@/features/voice/localWhisper"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

export default function VoiceSettingsScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(voiceStyles)
  const [models, setModels] = useState<MobileModelStatus[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, DownloadProgress | undefined>>({})
  const [error, setError] = useState<string | null>(null)
  const [testText, setTestText] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState("")
  const [effectiveServer, setEffectiveServer] = useState<string | undefined>(undefined)
  const [serverSaved, setServerSaved] = useState(false)

  const reload = useCallback(async () => {
    setModels(await listMobileModels())
  }, [])

  useEffect(() => {
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : t("error")))
    void loadModelServer().then(setServerUrl).catch(() => undefined)
    void mobileModelBaseUrl().then(setEffectiveServer).catch(() => undefined)
  }, [reload, t])

  const download = async (model: MobileModelStatus) => {
    setBusy(model.spec.id)
    setError(null)
    setTestText(null)
    try {
      await downloadMobileModel(model.spec, (value) =>
        setProgress((current) => ({ ...current, [model.spec.id]: value })),
      )
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("downloadFailed"))
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
      setError(cause instanceof Error ? cause.message : t("importFailed"))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (model: MobileModelStatus) => {
    setBusy(model.spec.id)
    setError(null)
    try {
      await removeMobileModel(model.spec)
      await releaseWhisperModel()
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"))
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
      setTestText(text || t("noSpeech"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("recognitionFailed"))
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <IconButton label={t("back")} onPress={() => router.back()}>
          <Icon name="back" size={22} color={colors.text} />
        </IconButton>
        <Text style={styles.title}>{t("voiceModels")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.hint}>{t("phoneModelHint")}</Text>

        <SectionLabel>{t("phoneModel")}</SectionLabel>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {models === null ? <ActivityIndicator color={colors.accent} style={{ marginTop: 20 }} /> : null}

        {models?.map((model) => {
          const value = progress[model.spec.id]
          const percent = value?.totalBytes ? Math.min(100, Math.floor((value.receivedBytes / value.totalBytes) * 100)) : 0
          return (
            <Card key={model.spec.id} style={{ marginBottom: 12 }}>
              <View style={{ padding: 16, gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={styles.modelTitle}>{model.spec.label}</Text>
                  {model.installed ? (
                    <Badge text={model.selected ? t("selected") : t("installed")} tone={model.selected ? "accent" : "success"} />
                  ) : null}
                  <View style={{ flex: 1 }} />
                  <Text style={styles.size}>{formatModelSize(model.spec.sizeBytes)}</Text>
                </View>
                <Text style={styles.modelBody}>{model.spec.description}</Text>
                <Text style={styles.languages}>{model.spec.languages.join(" · ")}</Text>

                {value ? (
                  <View style={styles.progressRow}>
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${percent}%` }]} />
                    </View>
                    <Text style={styles.percent}>{percent}%</Text>
                  </View>
                ) : null}

                <View style={styles.actions}>
                  {model.installed ? (
                    <>
                      <Button
                        label={model.selected ? t("selected") : t("useThisModel")}
                        size="sm"
                        variant={model.selected ? "outline" : "primary"}
                        disabled={busy !== null || model.selected}
                        onPress={() => void select(model)}
                      />
                      <Button label={t("test")} size="sm" variant="outline" disabled={busy !== null} onPress={() => void test(model)} />
                      <Button label={t("delete")} size="sm" variant="danger" disabled={busy !== null} onPress={() => void remove(model)} />
                    </>
                  ) : (
                    <>
                      <Button
                        label={busy === model.spec.id ? t("downloading") : t("download")}
                        size="sm"
                        disabled={busy !== null}
                        onPress={() => void download(model)}
                      />
                      <Button
                        label={t("importFile")}
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onPress={() => void importModel(model)}
                      />
                    </>
                  )}
                </View>
              </View>
            </Card>
          )
        })}

        {testText !== null ? (
          <Card style={{ padding: 14, gap: 4, marginBottom: 12 }}>
            <Text style={styles.testLabel}>{t("testResult")}</Text>
            <Text style={styles.testText}>{testText}</Text>
          </Card>
        ) : null}

        <SectionLabel>{t("modelServer")}</SectionLabel>
        <Text style={styles.hint}>{t("modelServerHint")}</Text>
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
            label={t("save")}
            size="sm"
            variant="outline"
            onPress={() => {
              void saveModelServer(serverUrl)
                .then(() => mobileModelBaseUrl())
                .then((value) => {
                  setEffectiveServer(value)
                  setServerSaved(true)
                })
                .catch(() => setError(t("error")))
            }}
          />
        </View>
        <Text style={styles.source}>
          {t("downloadSource")}: {effectiveServer ?? t("upstreamDefault")}
          {serverSaved ? ` · ${t("saved")}` : ""}
        </Text>

        <SectionLabel>{t("hostModel")}</SectionLabel>
        <Card>
          <View style={{ flexDirection: "row", gap: 12, padding: 16 }}>
            <Icon name="server" size={18} color={colors.muted} />
            <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 19, color: colors.muted }}>{t("hostModelHint")}</Text>
          </View>
        </Card>
      </ScrollView>
    </View>
  )
}

const voiceStyles = (colors: Palette) =>
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
    content: { paddingHorizontal: 16, paddingBottom: 40 },
    hint: { fontSize: 11.5, lineHeight: 17, color: colors.faint, marginTop: 10, paddingHorizontal: 2 },
    error: { fontSize: 12.5, color: colors.danger, marginBottom: 8 },
    modelTitle: { fontSize: 15.5, fontWeight: "600", color: colors.text },
    size: { fontSize: 11.5, color: colors.faint },
    modelBody: { fontSize: 12.5, lineHeight: 18, color: colors.muted },
    languages: { fontSize: 11, color: colors.faint },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
    progressRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
    progressTrack: { flex: 1, height: 5, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" },
    progressFill: { height: 5, backgroundColor: colors.accent },
    percent: { fontSize: 10.5, color: colors.faint, width: 34, textAlign: "right" },
    testLabel: { fontSize: 11.5, fontWeight: "600", color: colors.faint },
    testText: { fontSize: 14.5, lineHeight: 21, color: colors.text },
    serverRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
    serverInput: {
      flex: 1,
      height: 42,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      fontSize: 13,
      color: colors.text,
    },
    source: { fontSize: 10.5, color: colors.faint, marginTop: 6, marginLeft: 2 },
  })
