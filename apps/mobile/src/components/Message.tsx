import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useT } from "@/i18n"
import { useTheme } from "@/theme"
import type { AssistantContent, SessionMessage } from "@/opencode/client"
import { Icon } from "./Icon"
import { Markdown } from "./Markdown"

export function MessageView({ message }: { message: SessionMessage }) {
  const { colors } = useTheme()
  const t = useT()

  if (message.type === "user") {
    return (
      <View style={{ alignItems: "flex-end", paddingLeft: 40 }}>
        <View
          style={{
            backgroundColor: colors.accent,
            borderRadius: 20,
            borderBottomRightRadius: 6,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: colors.accentText, fontSize: 15, lineHeight: 22 }} selectable>
            {message.text ?? ""}
          </Text>
        </View>
      </View>
    )
  }

  if (message.type === "assistant") {
    const blocks = dedupeBlocks(message.content ?? [])
    return (
      <View style={{ gap: 10 }}>
        {blocks.map((block, index) => (
          <ContentBlock key={index} block={block} />
        ))}
        {message.error?.message ? (
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.danger }}>{message.error.message}</Text>
        ) : null}
      </View>
    )
  }

  if (message.type === "idle") {
    const failed = message.outcome === "failed"
    return (
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginVertical: 6 }}>
        <View
          style={{
            width: 5,
            height: 5,
            borderRadius: 3,
            backgroundColor: failed ? colors.danger : colors.faint,
          }}
        />
        <Text style={{ fontSize: 11.5, color: failed ? colors.danger : colors.faint }}>
          {message.outcome === "interrupted" ? t("interrupted") : failed ? t("turnFailed") : t("turnEnded")}
        </Text>
      </View>
    )
  }

  if (message.type === "system" || message.type === "synthetic" || message.type === "skill") {
    const text = message.text ?? message.description ?? message.name ?? message.type
    return (
      <Text style={{ fontSize: 12, lineHeight: 18, color: colors.faint, textAlign: "center", marginVertical: 2 }}>
        {text}
      </Text>
    )
  }

  return null
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

function ContentBlock({ block }: { block: AssistantContent }) {
  if (block.type === "text") {
    return <Markdown text={(block as { text: string }).text} />
  }

  if (block.type === "reasoning") {
    return <ReasoningBlock text={(block as { text: string }).text} />
  }

  if (block.type === "tool") {
    return <ToolBlockView block={block} />
  }

  return null
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
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} color={colors.faint} />
        <Text style={{ fontSize: 12, fontWeight: "500", color: colors.faint }}>{t("thinkingChars", { n: text.length })}</Text>
      </Pressable>
      {open ? (
        <Text
          style={{
            marginTop: 4,
            paddingLeft: 20,
            fontSize: 13,
            lineHeight: 20,
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

function ToolBlockView({ block }: { block: AssistantContent }) {
  const t = useT()
  const { colors } = useTheme()
  const tool = block as unknown as {
    name: string
    state?: {
      status?: string
      input?: unknown
      content?: Array<{ type: string; text?: string }>
      error?: { message?: string }
    }
  }
  const status = tool.state?.status ?? "running"
  const tone = status === "error" ? "error" : status === "completed" ? "done" : "running"
  const output = (tool.state?.content ?? [])
    .map((item) => (item.type === "text" ? (item.text ?? "") : ""))
    .filter((item) => item.length > 0)
    .join("\n")
  const input = tool.state?.input

  return (
    <Collapsible
      icon="terminal"
      title={tool.name || "tool"}
      subtitle={summarizeInput(input)}
      tone={tone}
      statusLabel={status === "error" ? t("toolFailed") : status === "completed" ? t("toolDone") : t("toolRunning")}
    >
      {input !== undefined ? (
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 11, fontWeight: "600", color: colors.faint }}>{t("toolInput")}</Text>
          <Text style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 18, color: colors.text }} selectable>
            {pretty(input)}
          </Text>
        </View>
      ) : null}
      <View style={{ gap: 4, marginTop: 8 }}>
        <Text style={{ fontSize: 11, fontWeight: "600", color: colors.faint }}>{t("toolOutput")}</Text>
        <Text style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 18, color: colors.text }} selectable>
          {tool.state?.error?.message ?? output ?? t("toolNoOutput")}
        </Text>
      </View>
    </Collapsible>
  )
}

function Collapsible(props: {
  icon: "terminal"
  title: string
  subtitle?: string
  tone: "running" | "done" | "error"
  statusLabel?: string
  mono?: boolean
  children: React.ReactNode
}) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const toneColor = props.tone === "error" ? colors.danger : props.tone === "done" ? colors.success : colors.warning
  return (
    <View
      style={{
        borderRadius: 14,
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
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
          },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Icon name="terminal" size={16} color={colors.muted} />
        <Text
          style={{
            fontSize: 13,
            fontWeight: "600",
            color: colors.text,
            fontFamily: props.mono ? "monospace" : undefined,
            maxWidth: "42%",
          }}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text
            style={{
              flex: 1,
              fontSize: 12,
              color: colors.muted,
              fontFamily: props.mono ? "monospace" : undefined,
            }}
            numberOfLines={1}
          >
            {props.subtitle}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: toneColor }} />
        <Text style={{ fontSize: 11, color: toneColor, fontWeight: "500" }}>{props.statusLabel ?? ""}</Text>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} color={colors.faint} />
      </Pressable>
      {open ? (
        <View
          style={{
            paddingHorizontal: 12,
            paddingBottom: 12,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
            paddingTop: 10,
          }}
        >
          {props.children}
        </View>
      ) : null}
    </View>
  )
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
    return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text
  } catch {
    return String(value)
  }
}
