import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import { useEffect, useState } from "react"
import type { FormField, FormInfo, FormValue, PermissionRequest } from "@/opencode/client"
import { activeFields, buildAnswer, initialAnswers, validateForm, type FormAnswers } from "@/opencode/forms"
import { useT } from "@/i18n"
import { radius, spacing, useTheme, useThemedStyles, type Palette } from "@/theme"

export function PendingDock(props: {
  permissions: PermissionRequest[]
  forms: FormInfo[]
  busy: boolean
  onReplyPermission: (request: PermissionRequest, decision: "once" | "always" | "reject") => void
  onSubmitForm: (form: FormInfo, answer: FormAnswers) => void
  onCancelForm: (form: FormInfo) => void
}) {
  const t = useT()
  const styles = useThemedStyles(pendingStyles)
  const permission = props.permissions[0]
  if (permission) {
    return (
      <View style={styles.dock}>
        <View style={styles.dockHeader}>
          <Text style={styles.dockTitle}>{t("confirmationNeeded")}</Text>
          {props.permissions.length > 1 ? (
            <Text style={styles.queue}>
              1 / {props.permissions.length}
            </Text>
          ) : null}
        </View>
        <PermissionCard permission={permission} busy={props.busy} onReply={(decision) => props.onReplyPermission(permission, decision)} />
      </View>
    )
  }

  const form = props.forms[0]
  if (form) {
    return (
      <View style={styles.dock}>
        <View style={styles.dockHeader}>
          <Text style={styles.dockTitle}>{t("formNeeded")}</Text>
          {props.forms.length > 1 ? <Text style={styles.queue}>1 / {props.forms.length}</Text> : null}
        </View>
        <FormCard
          key={form.id}
          form={form}
          busy={props.busy}
          onSubmit={(answer) => props.onSubmitForm(form, answer)}
          onCancel={() => props.onCancelForm(form)}
        />
      </View>
    )
  }

  return null
}

function PermissionCard(props: {
  permission: PermissionRequest
  busy: boolean
  onReply: (decision: "once" | "always" | "reject") => void
}) {
  const t = useT()
  const styles = useThemedStyles(pendingStyles)
  const { permission } = props
  const resources = permission.resources.slice(0, 5)
  const more = permission.resources.length - resources.length

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{permissionTitle(permission.action, t)}</Text>
      {permission.message ? <Text style={styles.cardBody}>{permission.message}</Text> : null}
      {resources.length > 0 ? (
        <View style={styles.resources}>
          {resources.map((resource) => (
            <Text key={resource} style={styles.resource} numberOfLines={1}>
              {resource}
            </Text>
          ))}
          {more > 0 ? <Text style={styles.resourceMore}>{t("moreItems", { n: more })}</Text> : null}
        </View>
      ) : null}
      <View style={styles.actions}>
        <Action label={t("reject")} variant="ghost" disabled={props.busy} onPress={() => props.onReply("reject")} />
        <Action label={t("alwaysAllow")} variant="ghost" disabled={props.busy} onPress={() => props.onReply("always")} />
        <Action label={t("allowOnce")} variant="primary" disabled={props.busy} onPress={() => props.onReply("once")} />
      </View>
    </View>
  )
}

function FormCard(props: {
  form: FormInfo
  busy: boolean
  onSubmit: (answer: FormAnswers) => void
  onCancel: () => void
}) {
  const t = useT()
  const styles = useThemedStyles(pendingStyles)
  const [answers, setAnswers] = useState<FormAnswers>(() => initialAnswers(props.form))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setAnswers(initialAnswers(props.form))
    setError(null)
  }, [props.form])

  const fields = activeFields(props.form, answers).filter((field) => !field.hidden && field.type !== "external")
  const external = activeFields(props.form, answers).filter((field) => field.type === "external")

  const setValue = (key: string, value: FormValue | undefined) => {
    setAnswers((current) => {
      const next = { ...current }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
  }

  const submit = () => {
    const problem = validateForm(props.form, answers)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    props.onSubmit(buildAnswer(props.form, answers))
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{props.form.title}</Text>
      <ScrollView style={styles.formScroll} contentContainerStyle={styles.formFields} keyboardShouldPersistTaps="handled">
        {fields.map((field) => (
          <FieldInput key={field.key} field={field} value={answers[field.key]} onChange={(value) => setValue(field.key, value)} />
        ))}
        {external.map((field) => (
          <Pressable
            key={field.key}
            accessibilityRole="link"
            onPress={() => {
              if (field.url) void Linking.openURL(field.url)
            }}
            style={styles.external}
          >
            <Text style={styles.externalText}>{field.title ?? field.url}</Text>
            <Text style={styles.externalHint}>{t("openInBrowser")}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Action label={t("cancel")} variant="ghost" disabled={props.busy} onPress={props.onCancel} />
        <Action label={props.busy ? t("submitting") : t("submit")} variant="primary" disabled={props.busy} onPress={submit} />
      </View>
    </View>
  )
}

function FieldInput(props: { field: FormField; value: FormValue | undefined; onChange: (value: FormValue | undefined) => void }) {
  const { colors } = useTheme()
  const t = useT()
  const styles = useThemedStyles(pendingStyles)
  const { field } = props
  const label = field.title ?? field.key

  if (field.type === "boolean") {
    return (
      <View style={styles.field}>
        <View style={styles.booleanRow}>
          <View style={styles.booleanText}>
            <Text style={styles.fieldLabel}>{label}</Text>
            {field.description ? <Text style={styles.fieldHint}>{field.description}</Text> : null}
          </View>
          <Switch
            value={props.value === true}
            onValueChange={(value) => props.onChange(value)}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>
      </View>
    )
  }

  if (field.type === "multiselect") {
    const selected = Array.isArray(props.value) ? props.value : []
    return (
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {field.description ? <Text style={styles.fieldHint}>{field.description}</Text> : null}
        <View style={styles.chips}>
          {(field.options ?? []).map((option) => {
            const active = selected.includes(option.value)
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() =>
                  props.onChange(active ? selected.filter((value) => value !== option.value) : [...selected, option.value])
                }
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
              </Pressable>
            )
          })}
        </View>
      </View>
    )
  }

  if (field.type === "string" && field.options && field.options.length > 0) {
    return (
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {field.description ? <Text style={styles.fieldHint}>{field.description}</Text> : null}
        <View style={styles.chips}>
          {field.options.map((option) => {
            const active = props.value === option.value
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => props.onChange(option.value)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
              </Pressable>
            )
          })}
        </View>
      </View>
    )
  }

  const numeric = field.type === "number" || field.type === "integer"
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {field.description ? <Text style={styles.fieldHint}>{field.description}</Text> : null}
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={numeric ? "numeric" : "default"}
        onChangeText={(text) => {
          if (numeric) {
            if (text.trim() === "") props.onChange(undefined)
            else {
              const value = Number(text)
              if (!Number.isNaN(value)) props.onChange(value)
            }
          } else {
            props.onChange(text)
          }
        }}
        placeholder={field.placeholder}
        placeholderTextColor={colors.faint}
        style={styles.input}
        value={props.value === undefined ? "" : String(props.value)}
      />
    </View>
  )
}

function Action(props: { label: string; variant: "primary" | "ghost"; disabled: boolean; onPress: () => void }) {
  const styles = useThemedStyles(pendingStyles)
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.action,
        props.variant === "primary" ? styles.actionPrimary : styles.actionGhost,
        props.disabled && styles.actionDisabled,
        pressed && styles.actionPressed,
      ]}
    >
      <Text style={props.variant === "primary" ? styles.actionPrimaryText : styles.actionGhostText}>{props.label}</Text>
    </Pressable>
  )
}

function permissionTitle(action: string, t: ReturnType<typeof useT>): string {
  const value = action.toLowerCase()
  if (value.includes("bash") || value.includes("shell") || value.includes("command")) return t("permRunCommand")
  if (value.includes("edit") || value.includes("write") || value.includes("patch")) return t("permEditFile")
  if (value.includes("read")) return t("permReadFile")
  if (value.includes("webfetch") || value.includes("fetch")) return t("permNetwork")
  return action || t("permAction")
}

const pendingStyles = (colors: Palette) =>
  StyleSheet.create({
  dock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface2,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  dockHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  dockTitle: { fontSize: 12, fontWeight: "600", color: colors.muted },
  queue: { fontSize: 12, color: colors.faint },
  card: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  cardBody: { fontSize: 13, lineHeight: 19, color: colors.muted },
  resources: { gap: 3 },
  resource: {
    fontSize: 12,
    color: colors.text,
    fontFamily: "monospace",
    backgroundColor: colors.surface2,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  resourceMore: { fontSize: 12, color: colors.faint },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.xs },
  action: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 1, borderRadius: radius.full },
  actionPrimary: { backgroundColor: colors.accent },
  actionGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border },
  actionDisabled: { opacity: 0.4 },
  actionPressed: { opacity: 0.7 },
  actionPrimaryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  actionGhostText: { color: colors.text, fontSize: 13, fontWeight: "500" },
  formScroll: { maxHeight: 300 },
  formFields: { gap: spacing.md },
  field: { gap: 5 },
  fieldLabel: { fontSize: 13, fontWeight: "500", color: colors.text },
  fieldHint: { fontSize: 12, lineHeight: 17, color: colors.faint },
  input: {
    minHeight: 40,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
  },
  booleanRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  booleanText: { flex: 1, gap: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 13, color: colors.text },
  chipTextActive: { color: "#FFFFFF", fontWeight: "600" },
  external: { paddingVertical: spacing.sm },
  externalText: { fontSize: 13, color: colors.accent },
  externalHint: { fontSize: 11, color: colors.faint },
  error: { fontSize: 12, color: colors.danger },
})
