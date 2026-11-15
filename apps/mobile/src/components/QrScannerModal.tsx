import { CameraView, useCameraPermissions } from "expo-camera"
import { useEffect, useRef } from "react"
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { Button, IconButton } from "@/components/ui"
import { useT } from "@/i18n"
import { useTheme } from "@/theme"

/**
 * Full-screen QR scanner. Keeping CameraView out of transparent bottom sheets
 * and nested ScrollViews avoids the Android preview/scanner deadlock seen in
 * host settings.
 */
export function QrScannerModal(props: {
  visible: boolean
  title: string
  onClose: () => void
  onScanned: (data: string) => void
}) {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const t = useT()
  const [permission, requestPermission] = useCameraPermissions()
  const locked = useRef(false)

  useEffect(() => {
    if (!props.visible) {
      locked.current = false
      return
    }
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission()
    }
  }, [permission, props.visible, requestPermission])

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={props.onClose}
    >
      <View style={[styles.screen, { paddingTop: insets.top, backgroundColor: "#000000" }]}>
        <View style={styles.header}>
          <IconButton label={t("back")} onPress={props.onClose}>
            <Icon name="close" size={22} color="#FFFFFF" />
          </IconButton>
          <Text style={styles.title}>{props.title}</Text>
          <View style={{ width: 40 }} />
        </View>
        {permission?.granted ? (
          <View style={styles.cameraWrap}>
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              facing="back"
              onBarcodeScanned={({ data }) => {
                if (locked.current) return
                locked.current = true
                props.onScanned(data)
              }}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.overlay} pointerEvents="none">
              <View style={styles.frame} />
              <Text style={styles.hint}>{t("scanTransportHint")}</Text>
            </View>
          </View>
        ) : (
          <View style={styles.permission}>
            <Icon name="eye" size={30} color="#FFFFFF" />
            <Text style={styles.permissionTitle}>{t("cameraPermission")}</Text>
            <Text style={styles.permissionBody}>{t("cameraBody")}</Text>
            {permission?.canAskAgain === false ? (
              <Button
                label={t("openSystemSettings")}
                size="sm"
                variant="outline"
                onPress={() => void Linking.openSettings()}
              />
            ) : (
              <Button label={t("allowCamera")} size="sm" onPress={() => void requestPermission()} />
            )}
            <Pressable accessibilityRole="button" onPress={props.onClose} style={styles.cancel}>
              <Text style={{ color: colors.faint, fontSize: 13 }}>{t("cancel")}</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  title: { fontSize: 17, fontWeight: "700", color: "#FFFFFF" },
  cameraWrap: { flex: 1, overflow: "hidden" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
  },
  frame: {
    width: 230,
    height: 230,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.92)",
  },
  hint: { fontSize: 13, color: "rgba(255,255,255,0.86)", textAlign: "center", paddingHorizontal: 28 },
  permission: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 28 },
  permissionTitle: { fontSize: 17, fontWeight: "700", color: "#FFFFFF" },
  permissionBody: { fontSize: 13, lineHeight: 19, color: "rgba(255,255,255,0.72)", textAlign: "center" },
  cancel: { marginTop: 10, padding: 10 },
})
