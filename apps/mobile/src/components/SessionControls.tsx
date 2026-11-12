import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useState } from "react"
import type { AgentInfo, ModelInfo, SessionInfo } from "@/opencode/client"
import { colors, radius, spacing } from "@/theme"

type Picker = "agent" | "model" | null

export function SessionControls(props: {
  session: SessionInfo
  disabled: boolean
  loadAgents: () => Promise<AgentInfo[]>
  loadModels: () => Promise<ModelInfo[]>
  onSelectAgent: (agent: string) => Promise<void>
  onSelectModel: (model: { id: string; providerID: string; variant?: string }) => Promise<void>
}) {
  const [picker, setPicker] = useState<Picker>(null)
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async (kind: Exclude<Picker, null>) => {
    setPicker(kind)
    setError(null)
    if ((kind === "agent" && agents) || (kind === "model" && models)) return
    setLoading(true)
    try {
      if (kind === "agent") setAgents(await props.loadAgents())
      else setModels(await props.loadModels())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }

  const selectAgent = async (agent: string) => {
    setBusy(true)
    setError(null)
    try {
      await props.onSelectAgent(agent)
      setPicker(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换 Agent 失败")
    } finally {
      setBusy(false)
    }
  }

  const selectModel = async (model: { id: string; providerID: string; variant?: string }) => {
    setBusy(true)
    setError(null)
    try {
      await props.onSelectModel(model)
      setPicker(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换模型失败")
    } finally {
      setBusy(false)
    }
  }

  const currentAgent = props.session.agent ?? "默认 Agent"
  const currentModel = props.session.model?.id ?? "默认模型"

  return (
    <>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => void open("agent")}
          style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        >
          <Text style={styles.pillLabel}>Agent</Text>
          <Text style={styles.pillValue} numberOfLines={1}>
            {currentAgent}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => void open("model")}
          style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        >
          <Text style={styles.pillLabel}>模型</Text>
          <Text style={styles.pillValue} numberOfLines={1}>
            {currentModel}
          </Text>
        </Pressable>
      </View>

      <Modal animationType="slide" transparent visible={picker !== null} onRequestClose={() => setPicker(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPicker(null)} />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{picker === "agent" ? "选择 Agent" : "选择模型"}</Text>
            <Pressable accessibilityRole="button" onPress={() => setPicker(null)}>
              <Text style={styles.close}>关闭</Text>
            </Pressable>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {loading ? <Text style={styles.loading}>正在加载…</Text> : null}
          <ScrollView contentContainerStyle={styles.list}>
            {picker === "agent"
              ? agents
                  ?.filter((agent) => !agent.hidden && agent.mode !== "subagent")
                  .map((agent) => {
                    const selected = props.session.agent === agent.id
                    return (
                      <Pressable
                        key={agent.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        disabled={busy}
                        onPress={() => void selectAgent(agent.id)}
                        style={[styles.option, selected && styles.optionSelected]}
                      >
                        <View style={styles.optionTitleRow}>
                          <View style={[styles.agentDot, { backgroundColor: agent.color ?? colors.accent }]} />
                          <Text style={styles.optionTitle}>{agent.name}</Text>
                          {selected ? <Text style={styles.selectedMark}>✓</Text> : null}
                        </View>
                        {agent.description ? <Text style={styles.optionBody}>{agent.description}</Text> : null}
                      </Pressable>
                    )
                  })
              : groupModels(models).map((group) => (
                  <View key={group.providerID} style={styles.group}>
                    <Text style={styles.groupTitle}>{group.providerID}</Text>
                    {group.models.map((model) => {
                      const selected = props.session.model?.id === model.id && props.session.model.providerID === model.providerID
                      return (
                        <View key={`${model.providerID}/${model.id}`} style={styles.modelBlock}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            disabled={busy}
                            onPress={() => void selectModel({ id: model.id, providerID: model.providerID })}
                            style={[styles.option, selected && !props.session.model?.variant && styles.optionSelected]}
                          >
                            <View style={styles.optionTitleRow}>
                              <Text style={styles.optionTitle}>{model.name}</Text>
                              {selected && !props.session.model?.variant ? <Text style={styles.selectedMark}>✓</Text> : null}
                            </View>
                            <Text style={styles.optionMeta}>
                              {model.limit?.context ? `${Math.round(model.limit.context / 1000)}k` : ""}
                              {model.cost?.[0] ? ` · $${formatPrice(model.cost[0].input)}/$${formatPrice(model.cost[0].output)}` : ""}
                            </Text>
                          </Pressable>
                          {model.variants && model.variants.length > 0 ? (
                            <View style={styles.variants}>
                              {model.variants.map((variant) => {
                                const active =
                                  props.session.model?.id === model.id &&
                                  props.session.model.providerID === model.providerID &&
                                  props.session.model.variant === variant.id
                                return (
                                  <Pressable
                                    key={variant.id}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: active }}
                                    disabled={busy}
                                    onPress={() => void selectModel({ id: model.id, providerID: model.providerID, variant: variant.id })}
                                    style={[styles.variantChip, active && styles.variantActive]}
                                  >
                                    <Text style={[styles.variantText, active && styles.variantTextActive]}>{variant.id}</Text>
                                  </Pressable>
                                )
                              })}
                            </View>
                          ) : null}
                        </View>
                      )
                    })}
                  </View>
                ))}
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

function groupModels(models: ModelInfo[] | null): Array<{ providerID: string; models: ModelInfo[] }> {
  if (!models) return []
  const groups = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const list = groups.get(model.providerID) ?? []
    list.push(model)
    groups.set(model.providerID, list)
  }
  return [...groups.entries()].map(([providerID, list]) => ({ providerID, models: list }))
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "?"
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "")
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  pill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillLabel: { fontSize: 11, color: colors.faint },
  pillValue: { flex: 1, fontSize: 12, fontWeight: "500", color: colors.text },
  pressed: { opacity: 0.7 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    maxHeight: "72%",
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  sheetTitle: { fontSize: 18, fontWeight: "600", color: colors.text },
  close: { fontSize: 14, color: colors.muted },
  loading: { fontSize: 13, color: colors.muted, marginBottom: spacing.md },
  error: { fontSize: 13, color: colors.danger, marginBottom: spacing.md },
  list: { paddingBottom: spacing.xl, gap: spacing.sm },
  group: { gap: spacing.xs, marginBottom: spacing.sm },
  groupTitle: { fontSize: 12, fontWeight: "600", color: colors.faint, textTransform: "uppercase" },
  modelBlock: { gap: 2 },
  option: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 3,
  },
  optionSelected: { borderColor: colors.accent, backgroundColor: colors.surface2 },
  optionTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  agentDot: { width: 8, height: 8, borderRadius: 4 },
  optionTitle: { flex: 1, fontSize: 15, fontWeight: "500", color: colors.text },
  optionBody: { fontSize: 12, lineHeight: 17, color: colors.muted },
  optionMeta: { fontSize: 11, color: colors.faint },
  selectedMark: { fontSize: 14, color: colors.accent, fontWeight: "700" },
  variants: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  variantChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  variantActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  variantText: { fontSize: 11, color: colors.text },
  variantTextActive: { color: "#FFFFFF" },
})
