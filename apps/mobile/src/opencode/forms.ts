import type { FormField, FormInfo, FormValue } from "./client"

export type FormAnswers = Record<string, FormValue>

export function initialAnswers(form: FormInfo): FormAnswers {
  const answers: FormAnswers = {}
  for (const field of form.fields) {
    if (field.default !== undefined) answers[field.key] = cloneValue(field.default)
  }
  return answers
}

export function activeFields(form: FormInfo, answers: FormAnswers): FormField[] {
  return form.fields.filter((field) => isFieldActive(field, answers))
}

export function isFieldActive(field: FormField, answers: FormAnswers): boolean {
  if (!field.when || field.when.length === 0) return true
  return field.when.every((condition) => {
    const value = answers[condition.key]
    if (value === undefined) return false
    const matches = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value
    return condition.op === "eq" ? matches : !matches
  })
}

export function validateForm(form: FormInfo, answers: FormAnswers): string | null {
  for (const field of activeFields(form, answers)) {
    if (field.type === "external") continue
    const value = answers[field.key]
    const label = field.title ?? field.key

    if (field.required && isEmpty(value)) return `请填写 ${label}`
    if (value === undefined || value === "") continue

    if (field.type === "string" && typeof value === "string") {
      if (field.minLength !== undefined && value.length < field.minLength) return `${label} 至少 ${field.minLength} 个字符`
      if (field.maxLength !== undefined && value.length > field.maxLength) return `${label} 最多 ${field.maxLength} 个字符`
      if (field.pattern !== undefined && !new RegExp(field.pattern, "u").test(value)) return `${label} 格式不正确`
    }

    if ((field.type === "number" || field.type === "integer") && typeof value === "number") {
      if (field.type === "integer" && !Number.isInteger(value)) return `${label} 必须是整数`
      if (field.minimum !== undefined && value < field.minimum) return `${label} 不能小于 ${field.minimum}`
      if (field.maximum !== undefined && value > field.maximum) return `${label} 不能大于 ${field.maximum}`
    }

    if (field.type === "multiselect" && Array.isArray(value)) {
      if (field.minItems !== undefined && value.length < field.minItems) return `${label} 至少选择 ${field.minItems} 项`
      if (field.maxItems !== undefined && value.length > field.maxItems) return `${label} 最多选择 ${field.maxItems} 项`
    }
  }
  return null
}

export function buildAnswer(form: FormInfo, answers: FormAnswers): FormAnswers {
  const answer: FormAnswers = {}
  for (const field of activeFields(form, answers)) {
    if (field.type === "external") continue
    const value = answers[field.key]
    if (value !== undefined) answer[field.key] = cloneValue(value)
    else if (field.default !== undefined) answer[field.key] = cloneValue(field.default)
  }
  return answer
}

function isEmpty(value: FormValue | undefined): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0)
}

function cloneValue(value: FormValue): FormValue {
  return Array.isArray(value) ? [...value] : value
}
