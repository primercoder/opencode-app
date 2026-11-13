import { parsePairingOffer, type PairingOffer } from "@ocremote/protocol"
import { CameraView, useCameraPermissions } from "expo-camera"
import { router, useLocalSearchParams } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { Button, Card, Divider, IconButton, Segmented } from "@/components/ui"
import { useT } from "@/i18n"
import { pairWithOffer, type PairingStage } from "@/services/pairing"
import { HostError } from "@/transport/hostRuntime"
import { useTheme, useThemedStyles, type Palette } from "@/theme"

export default function AddHostScreen() {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(addStyles)
  const params = useLocalSearchParams<{ url?: string }>()
  const urlParam = typeof params.url === "string" ? params.url : ""
  const [url, setUrl] = useState(urlParam)
  const [offer, setOffer] = useState<PairingOffer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<PairingStage | null>(null)
  const [mode, setMode] = useState<"scan" | "paste">("scan")
  const [scanLocked, setScanLocked] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const parsedParam = useRef(false)
  const busy = stage !== null || resolving

  useEffect(() => {
    if (!urlParam || parsedParam.current) return
    parsedParam.current = true
    setUrl(urlParam)
    void parseText(urlParam)
  }, [urlParam])

  const parseText = async (value: string) => {
    setResolving(true)
    setError(null)
    try {
      const resolved = await resolveInput(value)
      setOffer(parsePairingOffer(resolved))
      setMode("scan")
    } catch (cause) {
      setOffer(null)
      setError(cause instanceof Error ? cause.message : t("pairingFailed"))
    } finally {
      setResolving(false)
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
      setError(pairingMessage(failure, t))
    } finally {
      setStage(null)
    }
  }

  const stageLabel = stage
    ? { connecting: t("connecting"), handshaking: t("connecting"), authenticating: t("connecting"), saving: t("pairingNow") }[stage]
    : t("pairingNow")

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <IconButton label={t("back")} onPress={() => router.back()} disabled={stage !== null}>
          <Icon name="back" size={22} color={colors.text} />
        </IconButton>
        <Text style={styles.title}>{t("addHostTitle")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Segmented
          value={mode}
          options={[
            { value: "scan", label: t("scanQr") },
            { value: "paste", label: t("pasteLink") },
          ]}
          onChange={(value) => {
            setMode(value)
            setError(null)
          }}
        />

        {mode === "scan" ? (
          <View style={{ marginTop: 14, gap: 10 }}>
            {permission?.granted ? (
              <View style={styles.scannerWrap}>
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  facing="back"
                  onBarcodeScanned={
                    scanLocked || offer || stage !== null
                      ? undefined
                      : ({ data }) => {
                          setScanLocked(true)
                          setUrl(data)
                          void parseText(data).finally(() => setTimeout(() => setScanLocked(false), 800))
                        }
                  }
                  style={styles.scanner}
                />
                {!offer ? (
                  <View style={styles.scanOverlay} pointerEvents="none">
                    <View style={styles.scanFrame} />
                  </View>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setOffer(null)
                      setScanLocked(false)
                    }}
                    style={styles.rescan}
                  >
                    <Icon name="refresh" size={14} color={colors.accent} />
                    <Text style={{ fontSize: 12.5, color: colors.accent, fontWeight: "600" }}>{t("rescan")}</Text>
                  </Pressable>
                )}
                {resolving ? (
                  <View style={styles.resolving}>
                    <ActivityIndicator color="#FFFFFF" />
                  </View>
                ) : null}
              </View>
            ) : (
              <Card style={{ padding: 20, alignItems: "center", gap: 8 }}>
                <Icon name="eye" size={26} color={colors.faint} />
                <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text }}>{t("cameraPermission")}</Text>
                <Text style={{ fontSize: 12.5, color: colors.muted, textAlign: "center" }}>{t("cameraBody")}</Text>
                {permission?.canAskAgain === false ? (
                  <Button label={t("openSystemSettings")} size="sm" variant="outline" onPress={() => void Linking.openSettings()} />
                ) : (
                  <Button label={t("allowCamera")} size="sm" onPress={() => void requestPermission()} />
                )}
              </Card>
            )}
            <Text style={styles.hint}>{t("scanHint")}</Text>
          </View>
        ) : (
          <View style={{ marginTop: 14, gap: 8 }}>
            <Text style={styles.label}>{t("pairingLink")}</Text>
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
              placeholder="ocremote://pair#…"
              placeholderTextColor={colors.faint}
              style={styles.input}
              value={url}
            />
            <Text style={styles.hint}>{t("pasteHint")}</Text>
            <Button label={t("parseLink")} size="sm" variant="outline" disabled={busy || !url.trim()} onPress={() => void parseText(url)} />
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {offer ? (
          <Card style={{ marginTop: 14, padding: 16, gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ flex: 1, fontSize: 16.5, fontWeight: "700", color: colors.text }} numberOfLines={1}>
                {offer.name}
              </Text>
              <Text style={{ fontSize: 11.5, color: colors.accent, fontWeight: "600" }}>
                {t("routes", { n: offer.transports.length })}
              </Text>
            </View>
            <Divider inset={0} />
            <Text style={styles.label}>{t("fingerprint")}</Text>
            <Text style={styles.fingerprint}>{formatFingerprint(offer.fingerprint)}</Text>
            <Text style={styles.hint}>{t("verifyFingerprint")}</Text>
            <Text style={styles.hint}>
              {t("pairCode")} {offer.pairCode} · {t("validUntil", { time: new Date(offer.expiresAt).toLocaleTimeString() })}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
              <Icon name="lock" size={12} color={colors.faint} />
              <Text style={styles.hint}>{t("relayEncrypted")}</Text>
            </View>
          </Card>
        ) : null}

        {stage ? (
          <View style={styles.stage}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={{ fontSize: 13, color: colors.text }}>{stageLabel}</Text>
          </View>
        ) : null}

        {offer ? (
          <View style={{ marginTop: 14 }}>
            <Button label={busy ? t("pairingNow") : t("connectAndPair")} disabled={busy} onPress={() => void pair()} />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

async function resolveInput(value: string): Promise<string> {
  const trimmed = value.trim()
  if (!/^https?:\/\//u.test(trimmed)) return trimmed
  const response = await fetch(trimmed, { headers: { accept: "text/plain" } })
  if (!response.ok) throw new Error(`pairing link returned HTTP ${response.status}`)
  const text = (await response.text()).trim()
  if (text.startsWith("ocremote://")) return text
  try {
    const payload = JSON.parse(text) as { offer?: unknown }
    if (typeof payload.offer === "string") return payload.offer
  } catch {
    // not JSON
  }
  return text
}

function pairingMessage(error: HostError | null, t: ReturnType<typeof useT>): string {
  if (!error) return t("pairingFailed")
  if (error.code === "PAIR_CODE_INVALID") return t("pairCodeInvalid")
  if (error.kind === "network" || error.kind === "timeout") return t("cannotReachHost")
  return error.message
}

function formatFingerprint(value: string): string {
  return value.toUpperCase().match(/.{1,4}/gu)?.join(" ") ?? value.toUpperCase()
}

const addStyles = (colors: Palette) =>
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
    content: { paddingHorizontal: 16, paddingTop: 14 },
    scannerWrap: { borderRadius: 18, overflow: "hidden", backgroundColor: colors.surface2 },
    scanner: { height: 300, width: "100%" },
    scanOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
    scanFrame: {
      width: 210,
      height: 210,
      borderRadius: 26,
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.9)",
    },
    rescan: {
      position: "absolute",
      bottom: 12,
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.bg,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
    },
    resolving: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.35)",
      alignItems: "center",
      justifyContent: "center",
    },
    label: { fontSize: 11.5, fontWeight: "600", color: colors.faint },
    input: {
      minHeight: 96,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface,
      padding: 12,
      fontSize: 13,
      lineHeight: 19,
      color: colors.text,
      textAlignVertical: "top",
    },
    hint: { fontSize: 11.5, lineHeight: 17, color: colors.faint },
    error: { marginTop: 12, fontSize: 12.5, lineHeight: 18, color: colors.danger },
    fingerprint: { fontSize: 18, fontWeight: "700", letterSpacing: 1.6, color: colors.text },
    stage: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginTop: 14,
      padding: 12,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
  })
