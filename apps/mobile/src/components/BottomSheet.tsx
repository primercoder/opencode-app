import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/Icon"
import { IconButton } from "@/components/ui"
import { useTheme } from "@/theme"

export function BottomSheet(props: {
  visible: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  height?: number
  maxHeight?: number
}) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <Modal
      transparent
      visible={props.visible}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, justifyContent: "flex-end" }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlap }]} onPress={props.onClose} />
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
            ...(props.height ? { height: props.height } : {}),
            maxHeight: props.height ?? props.maxHeight ?? 620,
            paddingBottom: insets.bottom + 8,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
          }}
        >
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginTop: 8 }} />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 18,
              paddingTop: 10,
              paddingBottom: 6,
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>{props.title}</Text>
            <IconButton label="close" onPress={props.onClose}>
              <Icon name="close" size={20} color={colors.muted} />
            </IconButton>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 20 }}
            keyboardShouldPersistTaps="handled"
          >
            {props.children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
