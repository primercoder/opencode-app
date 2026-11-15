import { parsePairingOffer, type Transport } from "@ocremote/protocol"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native"
import { BottomSheet } from "@/components/BottomSheet"
import { QrScannerModal } from "@/components/QrScannerModal"
import { Button, Card, Segmented } from "@/components/ui"
import { useT } from "@/i18n"
import { resolvePairingInput } from "@/services/pairing"
import { enrollRelayClient, RelayAccessError } from "@/services/relay"
import { loadRelayAccess, normalizeRelayUrl } from "@/storage/relay"
import { useTheme } from "@/theme"

type Kind = "direct" | "relay"
type Source = "manual" | "scan"

/**
 * Adds one transport at a time. Direct routes accept a ws:// URL or a host
 * pairing code; relay routes accept a host pairing code and enroll this phone
 * with the relay before adding the route.
 */
export function TransportAddSheet(props: {
  visible: boolean
  onClose: () => void
  onAdd: (transport: Transport) => boolean
  existing: Transport[]
}) {
  const { colors } = useTheme()
  const t = useT()
  const styles = stylesFor(colors)
  const [kind, setKind] = useState<Kind>("direct")
  const [source, setSource] = useState<Source>("manual")
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const scanLocked = useRef(false)

  useEffect(() => {
    if (!props.visible) return
    setKind("direct")
    setSource("manual")
    setText("")
    setError(null)
    setBusy(false)
    setScannerOpen(false)
    scanLocked.current = false
  }, [props.visible])

  const submit = async (raw: string) => {
    const value = raw.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      const transport = await buildTransport(value, kind, props.existing)
      props.onAdd(transport)
      setScannerOpen(false)
      props.onClose()
    } catch (cause) {
      if (cause instanceof RelayAccessError) {
        setError(relayErrorText(cause, t))
      } else {
        setError(cause instanceof Error ? cause.message : t("error"))
      }
    } finally {
      setBusy(false)
    }
  }

  const scanned = (data: string) => {
    if (scanLocked.current || busy) return
    scanLocked.current = true
    setScannerOpen(false)
    void submit(data).finally(() => {
      setTimeout(() => {
        scanLocked.current = false
      }, 800)
    })
  }

  return (
    <BottomSheet visible={props.visible} title={t("addConnection")} onClose={props.onClose}>
      <Segmented
        value={kind}
        options={[
          { value: "direct", label: t("direct") },
          { value: "relay", label: t("relay") },
        ]}
        onChange={(value) => {
          setKind(value)
          setText("")
          setError(null)
        }}
      />
      <Text style={styles.hint}>{kind === "direct" ? t("directRouteHint") : t("relayRouteHint")}</Text>

      <View style={{ marginTop: 12 }}>
        <Segmented
          value={source}
          options={[
            { value: "manual", label: t("manual") },
            { value: "scan", label: t("scan") },
          ]}
          onChange={(value) => {
            setSource(value)
            setError(null)
            if (value === "scan") setScannerOpen(true)
          }}
        />
      </View>

      {source === "manual" ? (
        <Card style={{ padding: 12, gap: 8, marginTop: 12 }}>
          <Text style={styles.label}>{kind === "direct" ? t("address") : t("pairingLink")}</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            multiline
            onChangeText={(value) => {
              setText(value)
              setError(null)
            }}
            placeholder={kind === "direct" ? "ws://192.168.1.23:8787/ws" : "ocremote://pair#…"}
            placeholderTextColor={colors.faint}
            style={styles.input}
            value={text}
          />
          <Text style={styles.hint}>{kind === "direct" ? t("directHint") : t("relayPairingHint")}</Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
            {busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            <Button label={t("add")} size="sm" disabled={busy || !text.trim()} onPress={() => void submit(text)} />
          </View>
        </Card>
      ) : (
        <Card style={{ padding: 14, gap: 10, marginTop: 12, alignItems: "center" }}>
          <Text style={styles.hint}>{t("scanTransportHint")}</Text>
          <Button
            label={busy ? t("loading") : t("openScanner")}
            size="sm"
            disabled={busy}
            onPress={() => {
              scanLocked.current = false
              setScannerOpen(true)
            }}
          />
        </Card>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <QrScannerModal
        visible={scannerOpen}
        title={t("scan")}
        onClose={() => {
          scanLocked.current = false
          setScannerOpen(false)
        }}
        onScanned={scanned}
      />
    </BottomSheet>
  )
}

async function buildTransport(value: string, kind: Kind, existing: Transport[]): Promise<Transport> {
  const priority = existing.length
  if (/^wss?:\/\/\S+$/u.test(value) && kind === "direct") {
    return { kind: "lan", url: value, priority }
  }
  const offer = parsePairingOffer(await resolvePairingInput(value))
  if (kind === "direct") {
    const direct = offer.transports.find((transport) => transport.kind === "lan")
    if (!direct || direct.kind !== "lan") throw new Error("pairing offer has no direct route")
    return { kind: "lan", url: direct.url, priority }
  }
  const relay = offer.transports.find((transport) => transport.kind === "relay")
  if (!relay || relay.kind !== "relay") throw new Error("pairing offer has no relay route")
  const access = await loadRelayAccess(relay.url)
  if (relay.invite) {
    try {
      await enrollRelayClient({ link: relay.invite, room: relay.room })
      return { kind: "relay", url: normalizeRelayUrl(relay.url), room: relay.room, priority }
    } catch (cause) {
      if (!access) throw cause
    }
  } else if (!access) {
    throw new RelayAccessError("RELAY_INVITE_INVALID", "host pairing code has no relay invite")
  }
  return { kind: "relay", url: normalizeRelayUrl(relay.url), room: relay.room, priority }
}

function relayErrorText(error: RelayAccessError, t: ReturnType<typeof useT>): string {
  switch (error.code) {
    case "RELAY_INVITE_CONSUMED":
      return "这个邀请已经被使用，请重新扫描主机配对码。"
    case "RELAY_INVITE_EXPIRED":
      return "邀请已过期，请重新扫描主机配对码。"
    case "RELAY_INVITE_INVALID":
      return "中继访问链接无效，请重新扫描主机配对码。"
    case "RELAY_ROOM_NOT_FOUND":
      return t("relayNeedsPairing")
    default:
      return error.message || t("error")
  }
}

const stylesFor = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    hint: { marginTop: 8, fontSize: 11.5, lineHeight: 17, color: colors.faint },
    label: { fontSize: 11.5, fontWeight: "600", color: colors.faint },
    input: {
      minHeight: 64,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.surface,
      padding: 10,
      fontSize: 12.5,
      lineHeight: 18,
      color: colors.text,
      textAlignVertical: "top",
    },
    error: { marginTop: 10, fontSize: 12.5, lineHeight: 18, color: colors.danger },
  })
