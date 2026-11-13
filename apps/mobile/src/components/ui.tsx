import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native"
import { useTheme } from "@/theme"

export function Button(props: {
  label: string
  onPress: () => void
  variant?: "primary" | "outline" | "ghost" | "danger"
  disabled?: boolean
  size?: "md" | "sm"
  style?: ViewStyle
}) {
  const { colors } = useTheme()
  const variant = props.variant ?? "primary"
  const small = props.size === "sm"
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        {
          minHeight: small ? 36 : 46,
          paddingHorizontal: small ? 14 : 20,
          borderRadius: 999,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
        },
        variant === "primary" && { backgroundColor: colors.accent },
        variant === "outline" && { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
        variant === "ghost" && { backgroundColor: "transparent" },
        variant === "danger" && { backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: colors.danger },
        props.style,
        pressed && { opacity: 0.75 },
        props.disabled && { opacity: 0.4 },
      ]}
    >
      <Text
        style={{
          fontSize: small ? 13 : 15,
          fontWeight: "600",
          color:
            variant === "primary"
              ? colors.accentText
              : variant === "danger"
                ? colors.danger
                : colors.text,
        }}
      >
        {props.label}
      </Text>
    </Pressable>
  )
}

export function IconButton(props: {
  children: React.ReactNode
  onPress: () => void
  label: string
  disabled?: boolean
  size?: number
  active?: boolean
}) {
  const { colors } = useTheme()
  const size = props.size ?? 40
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: props.active ? colors.accentSoft : "transparent",
        },
        pressed && { opacity: 0.6 },
        props.disabled && { opacity: 0.35 },
      ]}
    >
      {props.children}
    </Pressable>
  )
}

export function SectionLabel({ children }: { children: string }) {
  const { colors } = useTheme()
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: "600",
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: colors.faint,
        marginTop: 24,
        marginBottom: 8,
        paddingHorizontal: 4,
      }}
    >
      {children}
    </Text>
  )
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { colors } = useTheme()
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: 16,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function Divider({ inset = 16 }: { inset?: number }) {
  const { colors } = useTheme()
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: inset }} />
}

export function Segmented<T extends string>(props: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  const { colors } = useTheme()
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: colors.surface2,
        borderRadius: 12,
        padding: 3,
        gap: 2,
      }}
    >
      {props.options.map((option) => {
        const active = option.value === props.value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onChange(option.value)}
            style={({ pressed }) => [
              {
                flex: 1,
                paddingVertical: 8,
                borderRadius: 9,
                alignItems: "center",
                backgroundColor: active ? colors.bg : "transparent",
              },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: active ? "600" : "500",
                color: active ? colors.text : colors.muted,
              }}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Badge({ text, tone = "neutral" }: { text: string; tone?: "neutral" | "accent" | "danger" | "success" }) {
  const { colors } = useTheme()
  const background =
    tone === "accent" ? colors.accentSoft : tone === "danger" ? colors.dangerSoft : colors.surface2
  const color = tone === "danger" ? colors.danger : tone === "accent" ? colors.accent : colors.muted
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: background }}>
      <Text style={{ fontSize: 11, fontWeight: "600", color }}>{text}</Text>
    </View>
  )
}

export function EmptyState(props: { icon?: React.ReactNode; title: string; body?: string }) {
  const { colors } = useTheme()
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 32, paddingTop: 64, gap: 10 }}>
      {props.icon}
      <Text style={{ fontSize: 18, fontWeight: "600", color: colors.text, textAlign: "center" }}>{props.title}</Text>
      {props.body ? (
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.muted, textAlign: "center" }}>{props.body}</Text>
      ) : null}
    </View>
  )
}
