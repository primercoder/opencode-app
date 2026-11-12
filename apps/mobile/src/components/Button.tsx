import { Pressable, StyleSheet, Text } from "react-native"
import { colors, radius, spacing } from "@/theme"

export function Button(props: {
  label: string
  onPress: () => void
  variant?: "primary" | "outline"
  disabled?: boolean
}) {
  const outline = props.variant === "outline"
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.base,
        outline ? styles.outline : styles.primary,
        pressed && styles.pressed,
        props.disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.label, outline ? styles.outlineLabel : styles.primaryLabel]}>{props.label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    minHeight: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.accent },
  outline: { borderWidth: 1, borderColor: colors.border, backgroundColor: "transparent" },
  label: { fontSize: 15, fontWeight: "500" },
  primaryLabel: { color: "#FFFFFF" },
  outlineLabel: { color: colors.text },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
})
