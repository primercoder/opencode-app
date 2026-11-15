import { useMemo } from "react"
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native"
import { useTheme, type Palette } from "@/theme"
import { parseMarkdown, type Block } from "@/lib/markdown"
import { useSelectionGuard } from "./selectionGuard"

export function Markdown({ text }: { text: string }) {
  const { colors } = useTheme()
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} colors={colors} />
      ))}
    </View>
  )
}

function BlockView({ block, colors }: { block: Block; colors: Palette }) {
  const guard = useSelectionGuard()
  const guardProps = guard
    ? { onPressIn: guard.onPressIn, onLongPress: guard.onLongPress }
    : {}

  if (block.type === "paragraph") {
    return (
      <Text selectable {...guardProps} style={{ fontSize: 15, lineHeight: 23, color: colors.text }}>
        {inline(block.text, colors)}
      </Text>
    )
  }

  if (block.type === "heading") {
    const size = block.level === 1 ? 21 : block.level === 2 ? 19 : 17
    return (
      <Text selectable {...guardProps} style={{ fontSize: size, lineHeight: size + 6, fontWeight: "700", color: colors.text, marginTop: 4 }}>
        {inline(block.text, colors)}
      </Text>
    )
  }

  if (block.type === "code") {
    return (
      <View style={{ borderRadius: 12, backgroundColor: colors.codeBg, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
        {block.lang ? (
          <Text style={{ fontSize: 11, color: colors.faint, paddingHorizontal: 12, paddingTop: 8, fontWeight: "600" }}>
            {block.lang}
          </Text>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12 }}>
          <Text
            selectable
            {...guardProps}
            style={{
              fontSize: 12.5,
              lineHeight: 19,
              color: colors.text,
              fontFamily: "monospace",
            }}
          >
            {block.text}
          </Text>
        </ScrollView>
      </View>
    )
  }

  if (block.type === "list") {
    return (
      <View style={{ gap: 5 }}>
        {block.items.map((item, index) => (
          <View key={index} style={{ flexDirection: "row", gap: 8, paddingLeft: item.level * 16 }}>
            <Text selectable {...guardProps} style={{ fontSize: 15, lineHeight: 22, color: colors.muted, minWidth: block.ordered ? 20 : 12 }}>
              {block.ordered ? `${index + 1}.` : "•"}
            </Text>
            <Text selectable {...guardProps} style={{ flex: 1, fontSize: 15, lineHeight: 22, color: colors.text }}>{inline(item.text, colors)}</Text>
          </View>
        ))}
      </View>
    )
  }

  if (block.type === "quote") {
    return (
      <View style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 12 }}>
        <Text selectable {...guardProps} style={{ fontSize: 14.5, lineHeight: 22, color: colors.muted }}>{inline(block.text, colors)}</Text>
      </View>
    )
  }

  if (block.type === "rule") {
    return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 }} />
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        {block.rows.map((row, rowIndex) => (
          <View key={rowIndex} style={{ flexDirection: "row", backgroundColor: rowIndex === 0 ? colors.surface2 : "transparent" }}>
            {row.map((cell, cellIndex) => (
              <Text
                key={cellIndex}
                selectable
                {...guardProps}
                style={{
                  width: 140,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  fontSize: 12,
                  color: colors.text,
                  fontWeight: rowIndex === 0 ? "600" : "400",
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                }}
              >
                {cell}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function inline(text: string, colors: Palette): React.ReactNode[] {
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|~~[^~\n]+~~|\*[^*\n]+\*)/gu
  const parts = text.split(pattern).filter((part) => part.length > 0)
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <Text key={index} style={{ fontWeight: "700" }}>
          {part.slice(2, -2)}
        </Text>
      )
    }
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return (
        <Text key={index} style={{ textDecorationLine: "line-through", color: colors.muted }}>
          {part.slice(2, -2)}
        </Text>
      )
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <Text
          key={index}
          style={{
            fontFamily: "monospace",
            fontSize: 13,
            color: colors.text,
            backgroundColor: colors.codeBg,
          }}
        >
          {part.slice(1, -1)}
        </Text>
      )
    }
    if (part.startsWith("[")) {
      const match = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(part)
      if (match) {
        const label = match[1] ?? ""
        const url = match[2] ?? ""
        return (
          <Text
            key={index}
            onPress={() => void Linking.openURL(url).catch(() => undefined)}
            style={{ color: colors.accent, textDecorationLine: "underline" }}
          >
            {label}
          </Text>
        )
      }
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <Text key={index} style={{ fontStyle: "italic" }}>
          {part.slice(1, -1)}
        </Text>
      )
    }
    return <Text key={index}>{part}</Text>
  })
}
