import { describe, expect, test } from "bun:test"
import { activeFields, buildAnswer, initialAnswers, validateForm } from "../src/opencode/forms.ts"
import type { FormInfo } from "../src/opencode/client.ts"

const form: FormInfo = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Pick an approach",
  fields: [
    { type: "string", key: "approach", title: "Approach", required: true },
    { type: "boolean", key: "runTests", title: "Run tests", default: true },
    {
      type: "multiselect",
      key: "files",
      title: "Files",
      options: [
        { value: "a.ts", label: "a.ts" },
        { value: "b.ts", label: "b.ts" },
      ],
      when: [{ key: "runTests", op: "eq", value: true }],
    },
    { type: "string", key: "hiddenNote", hidden: true, default: "auto" },
  ],
}

describe("forms", () => {
  test("seeds defaults", () => {
    expect(initialAnswers(form)).toEqual({ runTests: true, hiddenNote: "auto" })
  })

  test("evaluates when conditions", () => {
    expect(activeFields(form, { runTests: true }).map((field) => field.key)).toEqual(["approach", "runTests", "files", "hiddenNote"])
    expect(activeFields(form, { runTests: false }).map((field) => field.key)).toEqual(["approach", "runTests", "hiddenNote"])
  })

  test("validates required and pattern fields", () => {
    expect(validateForm(form, {})).toBe("请填写 Approach")
    expect(validateForm({ ...form, fields: [{ type: "string", key: "x", required: true, pattern: "^a+$" }] }, { x: "bb" })).toBe(
      "x 格式不正确",
    )
    expect(validateForm(form, { approach: "minimal" })).toBeNull()
  })

  test("builds an answer for active fields only", () => {
    expect(buildAnswer(form, { approach: "minimal", runTests: false, files: ["a.ts"], hiddenNote: "auto" })).toEqual({
      approach: "minimal",
      runTests: false,
      hiddenNote: "auto",
    })
  })
})
