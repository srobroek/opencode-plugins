import { expect, test } from "bun:test"
import type { Question } from "./questions.ts"
import { structuredDefault, validateStructuredValue } from "./structured.ts"
import { calendarText, structuredChoose, structuredEditText, structuredRows, structuredSetText, structuredStep } from "./structured-ui.ts"
import { acceptsPath, arrowAction, initialDraft, keyHints } from "./tui-state.ts"

const options = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }]
const q = (kind: Question["kind"], extra: Partial<Question> = {}): Question => ({ id: "q", title: kind, kind, ...extra })

test("UI values can be reactive store proxies without structuredClone errors", () => {
  const question = q("range", { min: 0, max: 10 })
  const draft = { ...initialDraft(question), value: new Proxy({ min: 2, max: 6 }, {}) }
  expect(structuredEditText(question, draft)).toBe("2")
  expect(structuredStep(question, draft, 1).value).toEqual({ min: 3, max: 6 })
  expect(draft.value.min).toBe(2)
})

test("form edits one typed field and cycles choices/toggles/numbers", () => {
  const question = q("form", { config: { fields: [{ id: "name", label: "Name", type: "text", required: true }, { id: "n", label: "Count", type: "number", min: 1, max: 3 }, { id: "c", label: "Choice", type: "choice", options: ["x", "y"] }, { id: "t", label: "Toggle", type: "toggle" }] } })
  const initial = initialDraft(question)
  const edit = structuredSetText(question, initial, "Ada")
  expect("draft" in edit && (edit.draft.value as { fields: { name: string } }).fields.name).toBe("Ada")
  expect(structuredSetText(question, { ...initial, cursor: 1 }, "oops")).toHaveProperty("error")
  expect(structuredStep(question, { ...initial, cursor: 1 }, 10).value).toMatchObject({ fields: { n: 3 } })
  expect(structuredChoose(question, initial, 2).value).toMatchObject({ fields: { c: "y" } })
  expect(structuredChoose(question, initial, 3).value).toMatchObject({ fields: { t: true } })
})

test("buckets move one item without losing or duplicating it", () => {
  const question = q("buckets", { config: { items: options, categories: [{ id: "now", label: "Now" }, { id: "later", label: "Later" }] } })
  const next = structuredStep(question, initialDraft(question), 1)
  expect(next.value).toEqual({ buckets: { now: ["b"], later: ["a"] } })
  expect(validateStructuredValue(question, next.value)).toHaveProperty("value")
})

test("matching swaps partners to retain a bijection", () => {
  const question = q("match", { config: { items: options, targets: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] } })
  expect(structuredStep(question, initialDraft(question), 1).value).toEqual({ pairs: { a: "y", b: "x" } })
})

test("allocation transfers conserve the total, including typed redistribution", () => {
  const question = q("allocate", { options, config: { total: 100 }, step: 5 })
  const changed = structuredStep(question, { ...initialDraft(question), cursor: 1 }, 1)
  expect(changed.value).toEqual({ allocations: { a: 95, b: 5 } })
  const edited = structuredSetText(question, { ...initialDraft(question), cursor: 1 }, "80")
  expect("draft" in edited && edited.draft.value).toEqual({ allocations: { a: 20, b: 80 } })
})

test("matrix moves among cells and rejects invalid typed scores", () => {
  const question = q("matrix", { options, config: { criteria: options }, min: 0, max: 5, step: 1 })
  expect(structuredRows(question).map((row) => row.id)).toEqual(["a/a", "a/b", "b/a", "b/b"])
  expect(structuredStep(question, { ...initialDraft(question), cursor: 2 }, 2).value).toMatchObject({ scores: { b: { a: 2 } } })
  expect(structuredSetText(question, initialDraft(question), "6")).toHaveProperty("error")
  const uneven = q("matrix", { options, config: { criteria: options }, min: 0, max: 5, step: 2 })
  const bounded = structuredStep(uneven, initialDraft(uneven), 20)
  expect(bounded.value).toMatchObject({ scores: { a: { a: 4 } } })
  expect(validateStructuredValue(uneven, bounded.value)).toHaveProperty("value")
})

test("range endpoints never cross and typed endpoints honour bounds/step", () => {
  const question = q("range", { min: 0, max: 10, step: 2, recommended: { min: 2, max: 6 } })
  expect(structuredStep(question, initialDraft(question), 9).value).toEqual({ min: 6, max: 6 })
  expect(structuredSetText(question, initialDraft(question), "3")).toHaveProperty("error")
  const small = q("range", { min: 2e-12, max: 9e-12, step: 1e-12 })
  const next = structuredStep(small, initialDraft(small), 1)
  expect(next.value).toEqual({ min: 3e-12, max: 9e-12 })
  expect(validateStructuredValue(small, next.value)).toHaveProperty("value")
})

test("calendar arithmetic handles leap days, month-end and boundaries", () => {
  const question = q("date", { config: { min: "2024-01-01", max: "2024-12-31" }, recommended: { value: "2024-01-31" } })
  expect(structuredStep(question, initialDraft(question), 1, true).value).toEqual({ value: "2024-02-29" })
  expect(arrowAction(question, "down")).toEqual({ kind: "step", delta: 7 })
  expect(calendarText("2024-02-29")).toContain("[29]")
  expect(structuredSetText(question, initialDraft(question), "2024-02-30")).toHaveProperty("error")
  const time = q("time", { recommended: { value: "23:59" } })
  expect(structuredStep(time, initialDraft(time), 1).value).toEqual({ value: "23:59" })
  expect(arrowAction(time, "up")).toEqual({ kind: "step", delta: -60 })
  const datetime = q("datetime", { recommended: { value: "2024-02-28T09:30" } })
  expect(structuredStep(datetime, initialDraft(datetime), 1).value).toEqual({ value: "2024-02-29T09:30" })
  const earliest = q("date", { recommended: { value: "0000-01-01" } })
  const latest = q("date", { recommended: { value: "9999-12-31" } })
  expect(structuredStep(earliest, initialDraft(earliest), -1).value).toEqual({ value: "0000-01-01" })
  expect(structuredStep(latest, initialDraft(latest), 1).value).toEqual({ value: "9999-12-31" })
  expect(calendarText("0000-02-29")).toContain("[29]")
})

test("path completion filters files/dirs and never uploads file data", () => {
  const question = q("path", { multiple: true, config: { mode: "dirs" } })
  expect(acceptsPath(question, "src/")).toBe(true)
  expect(acceptsPath(question, "src/a.ts")).toBe(false)
  expect(structuredSetText(question, initialDraft(question), "src/, docs/")).toMatchObject({ draft: { value: { paths: ["src/", "docs/"] } } })
})

test("tags suggestions toggle alongside free-form tags, with count limits", () => {
  const question = q("tags", { config: { suggestions: ["fast", "safe"] }, max: 2 })
  const added = structuredChoose(question, initialDraft(question), 0)
  expect(added.value).toEqual({ tags: ["fast"] })
  expect(structuredChoose(question, added, 0).value).toEqual({ tags: [] })
  expect(structuredSetText(question, added, "custom, safe")).toMatchObject({ draft: { value: { tags: ["custom", "safe"] } } })
  expect(structuredSetText(question, added, "a,b,c")).toHaveProperty("error")
})

test("colour supports swatches and canonical hex input", () => {
  const question = q("colour", { config: { swatches: ["#ff0000", "#00ff00"] } })
  expect(structuredStep(question, initialDraft(question), 1).value).toEqual({ hex: "#00ff00" })
  expect(structuredSetText(question, initialDraft(question), "#ABC")).toMatchObject({ draft: { value: { hex: "#aabbcc" } } })
  expect(structuredEditText(question, initialDraft(question))).toBe("#ff0000")
})

test("every new kind has rows/defaults and contextual hints", () => {
  for (const question of [q("date"), q("time"), q("datetime"), q("colour"), q("tags"), q("path")]) {
    expect(structuredDefault(question)).toBeDefined()
    expect(keyHints(question, "panel")).toContain("e ")
  }
})
