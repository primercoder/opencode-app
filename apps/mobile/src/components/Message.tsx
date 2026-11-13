import { memo, useState } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native"
import { useT } from "@/i18n"
import { useTheme } from "@/theme"
import type { AssistantContent, SessionMessage } from "@/opencode/client"
import { Icon } from "./Icon"
import { Markdown } from "./Markdown"

export const MessageView = memo(function MessageView({ message }: { message: SessionMessage }) {
  const { colors } = useTheme()
  const t = useT()

  if (message.type === "user") {
    return (
      <View style={{ alignItems: "flex-end", paddingLeft: 44 }}>
        <View
          style={{
            backgroundColor: colors.surface2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
            borderRadius: 18,
            borderBottomRightRadius: 6,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22 }} selectable>
            {message.text ?? ""}
          </Text>
        </View>
      </View>
    )
  }

  if (message.type === "shell") {
    const status = message.status ?? "unknown"
    const running = status === "running"
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          borderRadius: 10,
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        }}
      >
        <Icon name="terminal" size={14} color={running ? colors.warning : colors.faint} />
        <Text style={{ flex: 1, fontSize: 12, color: colors.muted, fontFamily: "monospace" }} numberOfLines={1}>
          {message.command ?? message.text ?? "shell"}
        </Text>
        <Text style={{ fontSize: 10.5, color: running ? colors.warning : colors.faint }}>{status}</Text>
      </View>
    )
  }

  if (message.type === "assistant") {
    const blocks = dedupeBlocks(message.content ?? [])
    const groups = groupBlocks(blocks)
    return (
      <View style={{ gap: 10 }}>
        {groups.map((group, index) =>
          group.kind === "text" ? (
            <Markdown key={`text-${index}`} text={group.text} />
          ) : (
            <ActivityGroup key={`activity-${index}`} blocks={group.blocks} />
          ),
        )}
        {message.error?.message ? (
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.danger }}>{message.error.message}</Text>
        ) : null}
      </View>
    )
  }

  return null
})

type BlockGroup = { kind: "text"; text: string } | { kind: "activity"; blocks: AssistantContent[] }

function groupBlocks(blocks: AssistantContent[]): BlockGroup[] {
  const groups: BlockGroup[] = []
  let activity: AssistantContent[] = []
  const flush = () => {
    if (activity.length === 0) return
    groups.push({ kind: "activity", blocks: activity })
    activity = []
  }
  for (const block of blocks) {
    if (block.type === "text") {
      flush()
      groups.push({ kind: "text", text: block.text })
    } else {
      activity.push(block)
    }
  }
  flush()
  return groups
}

function ActivityGroup({ blocks }: { blocks: AssistantContent[] }) {
  const { colors } = useTheme()
  const t = useT()
  const [open, setOpen] = useState(false)
  const running = blocks.some((block) => block.type === "tool" && (block.state?.status ?? "running") === "running")

  if (blocks.length === 0) return null
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 11, paddingVertical: 8 },
          pressed && { opacity: 0.7 },
        ]}
      >
        {running ? <ActivityIndicator size="small" color={colors.warning} /> : <Icon name="spark" size={14} color={colors.faint} />}
        <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: running ? colors.warning : colors.muted }}>
          {t("thinkingTools", { n: blocks.length })}
        </Text>
        {running ? <Text style={{ fontSize: 10.5, color: colors.warning }}>{t("toolRunning")}</Text> : null}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} color={colors.faint} />
      </Pressable>
      {open ? (
        <View
          style={{
            paddingHorizontal: 10,
            paddingTop: 8,
            paddingBottom: 10,
            gap: 8,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
          }}
        >
          {blocks.map((block, index) =>
            block.type === "reasoning" ? (
              <ReasoningBlock key={`reasoning-${index}`} text={block.text} />
            ) : block.type === "tool" ? (
              <ToolBlockView key={`tool-${index}`} block={block} />
            ) : null,
          )}
        </View>
      ) : null}
    </View>
  )
}

function ReasoningBlock({ text }: { text: string }) {
  const { colors } = useTheme()
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.faint} />
        <Text style={{ fontSize: 11.5, fontWeight: "500", color: colors.faint }}>{t("thinkingChars", { n: text.length })}</Text>
      </Pressable>
      {open ? (
        <Text
          style={{
            marginTop: 4,
            paddingLeft: 19,
            fontSize: 12.5,
            lineHeight: 19,
            color: colors.muted,
            fontStyle: "italic",
          }}
          selectable
        >
          {text}
        </Text>
      ) : null}
    </View>
  )
}

function ToolBlockView({ block }: { block: Extract<AssistantContent, { type: "tool" }> }) {
  const t = useT()
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const status = block.state?.status ?? "running"
  const tone = status === "error" ? colors.danger : status === "completed" ? colors.success : colors.warning
  const content = (block.state as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? []
  const output = content
    .map((item) => (item.type === "text" ? (item.text ?? "") : ""))
    .filter((item) => item.length > 0)
    .join("\n")
  const input = block.state?.input

  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        backgroundColor: colors.bg,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 10, paddingVertical: 8 },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Icon name="terminal" size={14} color={colors.muted} />
        <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.text, maxWidth: "32%" }} numberOfLines={1}>
          {block.name || "tool"}
        </Text>
        <Text style={{ flex: 1, fontSize: 11.5, color: colors.muted, fontFamily: "monospace" }} numberOfLines={1}>
          {summarizeInput(input)}
        </Text>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: tone }} />
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.faint} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
          {input !== undefined ? (
            <>
              <Text style={{ fontSize: 10.5, fontWeight: "600", color: colors.faint, marginTop: 6 }}>{t("toolInput")}</Text>
              <Text style={{ fontFamily: "monospace", fontSize: 11.5, lineHeight: 17, color: colors.text }} selectable>
                {pretty(input)}
              </Text>
            </>
          ) : null}
          <Text style={{ fontSize: 10.5, fontWeight: "600", color: colors.faint, marginTop: 4 }}>{t("toolOutput")}</Text>
          <Text style={{ fontFamily: "monospace", fontSize: 11.5, lineHeight: 17, color: colors.text }} selectable>
            {block.state?.error?.message ?? output ?? t("toolNoOutput")}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

function dedupeBlocks(blocks: AssistantContent[]): AssistantContent[] {
  return blocks.filter((block, index) => {
    if (block.type !== "tool" || index === 0) return true
    const previous = blocks[index - 1]
    if (!previous || previous.type !== "tool") return true
    const current = block as unknown as { name?: string; state?: { input?: unknown } }
    const before = previous as unknown as { name?: string; state?: { input?: unknown } }
    if (current.name !== before.name) return true
    try {
      return JSON.stringify(current.state?.input) !== JSON.stringify(before.state?.input)
    } catch {
      return true
    }
  })
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return typeof input === "string" ? input : undefined
  const record = input as Record<string, unknown>
  for (const key of ["command", "filePath", "path", "pattern", "query", "url", "description", "prompt"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/gu, " ").slice(0, 120)
    }
  }
  return undefined
}

function pretty(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
    return text.length > 3_000 ? `${text.slice(0, 3_000)}\n…` : text
  } catch {
    return String(value)
  }
}
