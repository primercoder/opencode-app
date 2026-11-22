import { memo, useEffect, useRef, useState } from "react"
import * as Clipboard from "expo-clipboard"
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useT } from "@/i18n"
import { useTheme } from "@/theme"
import type { AssistantContent, SessionMessage } from "@/opencode/client"
import { BottomSheet, useBottomSheetHeight } from "./BottomSheet"
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
          <Text
            selectable
            selectionColor={colors.accent}
            style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}
          >
            {message.text ?? ""}
          </Text>
        </View>
      </View>
    )
  }

  if (message.type === "compaction") {
    return <CompactionView message={message} />
  }

  if (message.type === "shell") {
    const status = message.status ?? "unknown"
    const running = status === "running"
    const output = message.output?.output ?? ""
    return (
      <View
        style={{
          borderRadius: 10,
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 7,
          }}
        >
          <Icon name="terminal" size={14} color={running ? colors.warning : colors.faint} />
          <Text style={{ flex: 1, fontSize: 12, color: colors.muted, fontFamily: "monospace" }} numberOfLines={1}>
            {message.command ?? message.text ?? "shell"}
          </Text>
          <Text style={{ fontSize: 10.5, color: running ? colors.warning : colors.faint }}>
            {message.exit !== undefined ? `exit ${message.exit}` : status}
          </Text>
        </View>
        {output.trim() ? (
          <Text
            style={{
              paddingHorizontal: 10,
              paddingBottom: 9,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
              paddingTop: 7,
              fontSize: 11.5,
              lineHeight: 17,
              color: colors.text,
              fontFamily: "monospace",
            }}
          >
            {output.length > 4_000 ? `${output.slice(0, 4_000)}\n…` : output}
          </Text>
        ) : null}
      </View>
    )
  }

  if (message.type === "assistant") {
    const blocks = dedupeBlocks(message.content ?? [])
    const groups = groupBlocks(blocks)
    const live = message.metadata?.live === true
    const streaming = message.metadata?.streaming === true
    return (
      <View style={{ gap: 10 }}>
        {groups.map((group, index) =>
          group.kind === "text" ? (
            <AssistantText
              key={`text-${index}`}
              text={group.text}
              live={live}
              showCursor={streaming && index === groups.length - 1}
            />
          ) : (
            <ActivityGroup
              key={`activity-${index}`}
              blocks={group.blocks}
              // Only the trailing group of a live turn animates. Earlier
              // groups are already-finished thinking/tools and must not
              // spin; their real tool status still drives the header.
              live={live && index === groups.length - 1}
            />
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

/**
 * A live text group fades in once and keeps the animated caret at its end.
 * The caret is driven by `metadata.streaming`, so it disappears as soon as the
 * stream ends instead of waiting for the next transcript refresh.
 */
function AssistantText({ text, live, showCursor }: { text: string; live: boolean; showCursor: boolean }) {
  const { colors } = useTheme()
  const t = useT()
  const opacity = useRef(new Animated.Value(live ? 0.72 : 1)).current
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!live) {
      opacity.setValue(1)
      return
    }
    Animated.timing(opacity, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start()
  }, [live, opacity])

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  if (!text.trim() && !showCursor) return null

  const copy = () => {
    void Clipboard.setStringAsync(text)
      .then(() => {
        setCopied(true)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 1_200)
      })
      .catch(() => undefined)
  }

  return (
    <Animated.View style={{ opacity }}>
      <View
        style={{
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: 12,
          backgroundColor: colors.surface,
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: 4,
        }}
      >
        {raw ? (
          <Text
            selectable
            selectionColor={colors.accent}
            style={{ fontFamily: "monospace", fontSize: 12.5, lineHeight: 19, color: colors.text }}
          >
            {text}
          </Text>
        ) : (
          <Markdown text={text} />
        )}
        {showCursor && !raw ? <StreamingCursor /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 2, marginTop: 4 }}>
          {raw ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copied ? t("copied") : t("copy")}
              hitSlop={6}
              onPress={copy}
              style={({ pressed }) => [
                { width: 30, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center" },
                pressed && { opacity: 0.55 },
              ]}
            >
              <Icon name={copied ? "check" : "copy"} size={14} color={copied ? colors.success : colors.faint} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={raw ? t("viewRendered") : t("viewSource")}
            hitSlop={6}
            onPress={() => setRaw((value) => !value)}
            style={({ pressed }) => [
              { width: 30, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center" },
              pressed && { opacity: 0.55 },
            ]}
          >
            <Icon name={raw ? "eye" : "code"} size={14} color={colors.faint} />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  )
}

function StreamingCursor() {
  const { colors } = useTheme()
  const opacity = useRef(new Animated.Value(1)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: 480,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 480,
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [opacity])

  return (
    <Animated.View
      style={{
        width: 2,
        height: 15,
        marginTop: 3,
        marginLeft: 2,
        borderRadius: 1,
        backgroundColor: colors.accent,
        opacity,
      }}
    />
  )
}

function CompactionView({ message }: { message: SessionMessage }) {
  const { colors } = useTheme()
  const t = useT()
  const sheetHeight = useBottomSheetHeight()
  const [open, setOpen] = useState(false)
  const running = message.status === "running"
  const failed = message.status === "failed"
  const summary = message.summary?.trim() ?? ""
  const status = failed
    ? t("compactionFailed")
    : running
      ? t("compactionRunning")
      : t("compactionCompleted")
  const tone = failed ? colors.danger : running ? colors.warning : colors.success

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
        accessibilityState={{ expanded: open, disabled: !summary }}
        disabled={!summary}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 11, paddingVertical: 9 },
          pressed && { opacity: 0.7 },
        ]}
      >
        {running ? (
          <ActivityIndicator size="small" color={tone} />
        ) : (
          <Icon name={failed ? "close" : "bolt"} size={15} color={tone} />
        )}
        <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "600", color: tone }}>{status}</Text>
        {summary ? <Text style={{ fontSize: 10.5, color: colors.accent }}>{t("view")}</Text> : null}
        {summary ? <Icon name="chevronRight" size={14} color={colors.faint} /> : null}
      </Pressable>
      {failed && message.error?.message ? (
        <Text
          style={{
            paddingHorizontal: 11,
            paddingBottom: 10,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
            paddingTop: 8,
            fontSize: 12,
            lineHeight: 18,
            color: colors.danger,
          }}
        >
          {message.error.message}
        </Text>
      ) : null}
      <BottomSheet
        visible={open && Boolean(summary)}
        title={status}
        onClose={() => setOpen(false)}
        height={sheetHeight}
      >
        <Markdown text={summary} />
      </BottomSheet>
    </View>
  )
}

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

function ActivityGroup({ blocks, live = false }: { blocks: AssistantContent[]; live?: boolean }) {
  const { colors } = useTheme()
  const t = useT()
  const sheetHeight = useBottomSheetHeight()
  const [open, setOpen] = useState(false)
  const running =
    live || blocks.some((block) => block.type === "tool" && (block.state?.status ?? "running") === "running")

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
        onPress={() => setOpen(true)}
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
        <Icon name="chevronRight" size={14} color={colors.faint} />
      </Pressable>
      <BottomSheet
        visible={open}
        title={t("thinkingTools", { n: blocks.length })}
        onClose={() => setOpen(false)}
        height={sheetHeight}
      >
        <View style={{ gap: 8 }}>
          {blocks.map((block, index) =>
            block.type === "reasoning" ? (
              <ReasoningBlock key={`reasoning-${index}`} text={block.text} />
            ) : block.type === "tool" ? (
              <ToolBlockView key={`tool-${index}`} block={block} />
            ) : null,
          )}
        </View>
      </BottomSheet>
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
        <ScrollView nestedScrollEnabled style={{ maxHeight: 260 }}>
          <Text
            style={{
              marginTop: 4,
              paddingLeft: 19,
              fontSize: 12.5,
              lineHeight: 19,
              color: colors.muted,
              fontStyle: "italic",
            }}
          >
            {text}
          </Text>
        </ScrollView>
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
        <ScrollView
          nestedScrollEnabled
          style={{ maxHeight: 340, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}
          contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 10, gap: 6 }}
        >
          {input !== undefined ? (
            <>
              <Text style={{ fontSize: 10.5, fontWeight: "600", color: colors.faint, marginTop: 6 }}>{t("toolInput")}</Text>
              <Text
                style={{ fontFamily: "monospace", fontSize: 11.5, lineHeight: 17, color: colors.text }}
              >
                {pretty(input)}
              </Text>
            </>
          ) : null}
          <Text style={{ fontSize: 10.5, fontWeight: "600", color: colors.faint, marginTop: 4 }}>{t("toolOutput")}</Text>
          <Text
            style={{ fontFamily: "monospace", fontSize: 11.5, lineHeight: 17, color: colors.text }}
          >
            {block.state?.error?.message ?? output ?? t("toolNoOutput")}
          </Text>
        </ScrollView>
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
