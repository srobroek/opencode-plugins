import type { Question } from "./questions.ts"
import { canonical as canon } from "./value-json.ts"

/** Kinds whose answers are structured objects described by `question.config`. */
export const NEW_KINDS = [
  "form",
  "buckets",
  "match",
  "allocate",
  "matrix",
  "range",
  "path",
  "date",
  "time",
  "datetime",
  "tags",
  "colour",
] as const
export type StructuredKind = (typeof NEW_KINDS)[number]

export interface StructuredItem {
  readonly id: string
  readonly label: string
}

export const FORM_FIELD_TYPES = ["text", "number", "choice", "toggle"] as const
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

export interface FormField {
  readonly id: string
  readonly label: string
  readonly type: FormFieldType
  /** Choices for a `choice` field. */
  readonly options?: readonly string[]
  /** Bounds for a `number` field. */
  readonly min?: number
  readonly max?: number
  /** A required `text` field must not be blank. */
  readonly required?: boolean
}

export interface FormConfig {
  readonly fields: readonly FormField[]
}
export interface BucketsConfig {
  readonly items: readonly StructuredItem[]
  readonly categories: readonly StructuredItem[]
}
export interface MatchConfig {
  /** Left column. */
  readonly items: readonly StructuredItem[]
  /** Right column; same length as `items`. */
  readonly targets: readonly StructuredItem[]
}
export interface AllocateConfig {
  /** Amount to distribute over `question.options`; defaults to 100. */
  readonly total?: number
}
export interface MatrixConfig {
  readonly criteria: readonly StructuredItem[]
}
export type RangeConfig = Readonly<Record<string, never>>
export const PATH_MODES = ["files", "dirs", "both"] as const
export type PathMode = (typeof PATH_MODES)[number]
export interface PathConfig {
  readonly mode?: PathMode
}
/** ISO local strings: `YYYY-MM-DD` (date), `HH:mm` (time), `YYYY-MM-DDTHH:mm` (datetime). */
export interface TemporalConfig {
  readonly min?: string
  readonly max?: string
}
export interface TagsConfig {
  readonly suggestions?: readonly string[]
}
export interface ColourConfig {
  /** `#RRGGBB` swatches. */
  readonly swatches?: readonly string[]
}

/** `question.config`, keyed by question kind. */
export interface StructuredConfigs {
  readonly form: FormConfig
  readonly buckets: BucketsConfig
  readonly match: MatchConfig
  readonly allocate: AllocateConfig
  readonly matrix: MatrixConfig
  readonly range: RangeConfig
  readonly path: PathConfig
  readonly date: TemporalConfig
  readonly time: TemporalConfig
  readonly datetime: TemporalConfig
  readonly tags: TagsConfig
  readonly colour: ColourConfig
}
/**
 * `question.config` as `Question` carries it: every kind's fields, all optional, since `Question` is
 * not narrowed by kind. Use `StructuredConfigs[kind]` for the exact shape of one kind.
 */
export type StructuredConfig = Partial<
  FormConfig & BucketsConfig & MatchConfig & AllocateConfig & MatrixConfig & PathConfig & TemporalConfig & TagsConfig & ColourConfig
>

/** Canonical answer objects, keyed by question kind. */
export interface StructuredAnswers {
  readonly form: { readonly fields: Readonly<Record<string, string | number | boolean>> }
  readonly buckets: { readonly buckets: Readonly<Record<string, readonly string[]>> }
  readonly match: { readonly pairs: Readonly<Record<string, string>> }
  readonly allocate: { readonly allocations: Readonly<Record<string, number>> }
  readonly matrix: { readonly scores: Readonly<Record<string, Readonly<Record<string, number>>>> }
  readonly range: { readonly min: number; readonly max: number }
  readonly path: { readonly paths: readonly string[] }
  readonly date: { readonly value: string }
  readonly time: { readonly value: string }
  readonly datetime: { readonly value: string }
  readonly tags: { readonly tags: readonly string[] }
  readonly colour: { readonly hex: string }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const STEP_TOLERANCE = 1e-8
const ALLOCATION_TOLERANCE = 1e-8
const DEFAULT_TOTAL = 100
const NEUTRAL_COLOUR = "#808080"
const TEMPORAL_DEFAULTS = { date: "2026-01-01", time: "12:00", datetime: "2026-01-01T12:00" } as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

const tidy = (value: number) => Number(value.toPrecision(15))

export function isStructured<Q extends { readonly kind: string }>(
  question: Q,
): question is Q & { readonly kind: StructuredKind } {
  return (NEW_KINDS as readonly string[]).includes(question.kind)
}

type Temporal = "date" | "time" | "datetime"

type Spec =
  | { readonly kind: "form"; readonly fields: readonly FormField[] }
  | { readonly kind: "buckets"; readonly items: readonly StructuredItem[]; readonly categories: readonly StructuredItem[] }
  | { readonly kind: "match"; readonly items: readonly StructuredItem[]; readonly targets: readonly StructuredItem[] }
  | { readonly kind: "allocate"; readonly options: readonly StructuredItem[]; readonly total: number }
  | {
      readonly kind: "matrix"
      readonly options: readonly StructuredItem[]
      readonly criteria: readonly StructuredItem[]
      readonly min: number
      readonly max: number
      readonly step: number
    }
  | { readonly kind: "range"; readonly min: number; readonly max: number; readonly step: number; readonly unit?: string }
  | { readonly kind: "path"; readonly mode: PathMode; readonly multiple: boolean }
  | { readonly kind: Temporal; readonly min?: string; readonly max?: string }
  | { readonly kind: "tags"; readonly suggestions: readonly string[]; readonly min?: number; readonly max?: number }
  | { readonly kind: "colour"; readonly swatches: readonly string[] }

function parseItems(raw: unknown, path: string, errors: string[]): StructuredItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${path} must be a non-empty array`)
    return []
  }
  const items: StructuredItem[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`${path}[${index}] must be an object with id and label`)
      return
    }
    const { id, label } = entry
    if (typeof id !== "string" || !ID.test(id)) {
      errors.push(`${path}[${index}].id must match ${ID}`)
      return
    }
    if (seen.has(id)) {
      errors.push(`${path}: duplicate id ${id}`)
      return
    }
    seen.add(id)
    if (typeof label !== "string" || label.trim() === "") {
      errors.push(`${path}.${id}.label is required`)
      return
    }
    items.push({ id, label })
  })
  return items
}

/** Reads an optional finite number, reporting a non-finite or non-number one. */
function optionalNumber(raw: unknown, path: string, errors: string[]): number | undefined {
  if (raw === undefined) return undefined
  if (!finite(raw)) {
    errors.push(`${path} must be a finite number`)
    return undefined
  }
  return raw
}

function parseStep(raw: unknown, fallback: number, path: string, errors: string[]): number {
  if (raw === undefined) return fallback
  if (!finite(raw) || raw <= 0) {
    errors.push(`${path} must be a positive finite number`)
    return fallback
  }
  return raw
}

function parseFields(raw: unknown, errors: string[]): FormField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("config.fields must be a non-empty array")
    return []
  }
  const fields: FormField[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = `config.fields[${index}]`
    if (!isRecord(entry)) {
      errors.push(`${at} must be an object`)
      return
    }
    const { id, label, type, options, required } = entry
    if (typeof id !== "string" || !ID.test(id)) {
      errors.push(`${at}.id must match ${ID}`)
      return
    }
    if (seen.has(id)) {
      errors.push(`config.fields: duplicate id ${id}`)
      return
    }
    seen.add(id)
    const before = errors.length
    if (typeof label !== "string" || label.trim() === "") errors.push(`${at}.label is required`)
    if (typeof type !== "string" || !(FORM_FIELD_TYPES as readonly string[]).includes(type)) {
      errors.push(`${at}.type must be one of ${FORM_FIELD_TYPES.join(", ")}`)
      return
    }
    if (required !== undefined && typeof required !== "boolean") errors.push(`${at}.required must be a boolean`)
    const min = optionalNumber(entry.min, `${at}.min`, errors)
    const max = optionalNumber(entry.max, `${at}.max`, errors)
    if ((entry.min !== undefined || entry.max !== undefined) && type !== "number")
      errors.push(`${at}: min and max apply only to number fields`)
    if (min !== undefined && max !== undefined && min > max) errors.push(`${at}: min must be <= max`)
    let choices: string[] | undefined
    if (type === "choice") {
      if (!Array.isArray(options) || options.length === 0) errors.push(`${at}.options must be a non-empty array`)
      else if (options.some((option) => typeof option !== "string" || option.trim() === ""))
        errors.push(`${at}.options must be non-empty strings`)
      else if (new Set(options).size !== options.length) errors.push(`${at}.options has duplicates`)
      else choices = [...(options as string[])]
    } else if (options !== undefined) errors.push(`${at}.options apply only to choice fields`)
    if (errors.length > before) return
    fields.push({
      id,
      label: label as string,
      type: type as FormFieldType,
      ...(choices === undefined ? {} : { options: choices }),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(required === undefined ? {} : { required: required as boolean }),
    })
  })
  return fields
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^(\d{2}):(\d{2})$/

const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function validDate(text: string): boolean {
  const match = DATE.exec(text)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const days = month === 2 && leap(year) ? 29 : (DAYS[month - 1] as number)
  return day <= days
}

function validTime(text: string): boolean {
  const match = TIME.exec(text)
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60
}

/** Strict ISO local syntax and calendar validity for a temporal kind. */
export function validTemporal(kind: Temporal, text: unknown): text is string {
  if (typeof text !== "string") return false
  if (kind === "date") return validDate(text)
  if (kind === "time") return validTime(text)
  const [date, time, ...rest] = text.split("T")
  return rest.length === 0 && date !== undefined && time !== undefined && validDate(date) && validTime(time)
}

const TEMPORAL_FORMAT = { date: "YYYY-MM-DD", time: "HH:mm", datetime: "YYYY-MM-DDTHH:mm" } as const

const HEX6 = /^#[0-9a-fA-F]{6}$/
const HEX3 = /^#[0-9a-fA-F]{3}$/

/** `#rgb` or `#rrggbb` as canonical lower-case `#rrggbb`; undefined when malformed. */
export function canonicalHex(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined
  if (HEX6.test(text)) return text.toLowerCase()
  if (HEX3.test(text))
    return `#${[...text.slice(1)].map((digit) => `${digit}${digit}`).join("")}`.toLowerCase()
  return undefined
}

function parseSpec(question: Question): { spec: Spec } | { errors: string[] } {
  const errors: string[] = []
  const raw = (question as { config?: unknown }).config
  const needsConfig = question.kind === "form" || question.kind === "buckets" || question.kind === "match" || question.kind === "matrix"
  if (raw !== undefined && !isRecord(raw)) return { errors: ["config must be an object"] }
  if (raw === undefined && needsConfig) return { errors: [`config is required for ${question.kind}`] }
  const config: Record<string, unknown> = raw ?? {}
  const done = (spec: Spec) => (errors.length > 0 ? { errors } : { spec })
  switch (question.kind) {
    case "form":
      return done({ kind: "form", fields: parseFields(config.fields, errors) })
    case "buckets":
      return done({
        kind: "buckets",
        items: parseItems(config.items, "config.items", errors),
        categories: parseItems(config.categories, "config.categories", errors),
      })
    case "match": {
      const items = parseItems(config.items, "config.items", errors)
      const targets = parseItems(config.targets, "config.targets", errors)
      if (Array.isArray(config.items) && Array.isArray(config.targets) && config.items.length !== config.targets.length)
        errors.push("config.items and config.targets must have the same number of entries")
      return done({ kind: "match", items, targets })
    }
    case "allocate": {
      const options = parseItems(question.options, "options", errors)
      let total = DEFAULT_TOTAL
      if (config.total !== undefined) {
        if (!finite(config.total) || config.total <= 0) errors.push("config.total must be a positive finite number")
        else total = config.total
      }
      return done({ kind: "allocate", options, total })
    }
    case "matrix": {
      const options = parseItems(question.options, "options", errors)
      const criteria = parseItems(config.criteria, "config.criteria", errors)
      const min = optionalNumber(question.min, "min", errors) ?? 0
      const max = optionalNumber(question.max, "max", errors) ?? 5
      const step = parseStep(question.step, 1, "step", errors)
      if (min >= max) errors.push("min must be < max")
      return done({ kind: "matrix", options, criteria, min, max, step })
    }
    case "range": {
      if (question.min === undefined || question.max === undefined) errors.push("min and max are required")
      const min = optionalNumber(question.min, "min", errors) ?? 0
      const max = optionalNumber(question.max, "max", errors) ?? 0
      const step = parseStep(question.step, 1, "step", errors)
      if (errors.length === 0 && min >= max) errors.push("min must be < max")
      if (question.unit !== undefined && typeof question.unit !== "string") errors.push("unit must be a string")
      return done({ kind: "range", min, max, step, ...(typeof question.unit === "string" ? { unit: question.unit } : {}) })
    }
    case "path": {
      let mode: PathMode = "both"
      if (config.mode !== undefined) {
        if (typeof config.mode !== "string" || !(PATH_MODES as readonly string[]).includes(config.mode))
          errors.push(`config.mode must be one of ${PATH_MODES.join(", ")}`)
        else mode = config.mode as PathMode
      }
      return done({ kind: "path", mode, multiple: question.multiple === true })
    }
    case "date":
    case "time":
    case "datetime": {
      const kind = question.kind
      const read = (key: "min" | "max") => {
        const value = config[key]
        if (value === undefined) return undefined
        if (!validTemporal(kind, value)) {
          errors.push(`config.${key} must be a valid ${TEMPORAL_FORMAT[kind]}`)
          return undefined
        }
        return value
      }
      const min = read("min")
      const max = read("max")
      if (min !== undefined && max !== undefined && min > max) errors.push("config.min must be <= config.max")
      return done({ kind, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) })
    }
    case "tags": {
      let suggestions: string[] = []
      if (config.suggestions !== undefined) {
        const list = config.suggestions
        if (!Array.isArray(list) || list.some((tag) => typeof tag !== "string" || tag.trim() === ""))
          errors.push("config.suggestions must be an array of non-empty strings")
        else if (new Set(list.map((tag: string) => tag.trim())).size !== list.length)
          errors.push("config.suggestions has duplicates")
        else suggestions = list.map((tag: string) => tag.trim())
      }
      const count = (key: "min" | "max") => {
        const value = question[key]
        if (value === undefined) return undefined
        if (!finite(value) || !Number.isInteger(value) || value < 0) {
          errors.push(`${key} must be a non-negative integer`)
          return undefined
        }
        return value
      }
      const min = count("min")
      const max = count("max")
      if (min !== undefined && max !== undefined && min > max) errors.push("min must be <= max")
      return done({ kind: "tags", suggestions, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) })
    }
    case "colour": {
      let swatches: string[] = []
      if (config.swatches !== undefined) {
        const list = config.swatches
        if (!Array.isArray(list) || list.some((swatch) => typeof swatch !== "string" || !HEX6.test(swatch)))
          errors.push("config.swatches must be an array of #RRGGBB colours")
        else {
          const lower = list.map((swatch: string) => swatch.toLowerCase())
          if (new Set(lower).size !== lower.length) errors.push("config.swatches has duplicates")
          else swatches = lower
        }
      }
      return done({ kind: "colour", swatches })
    }
    default:
      return { errors: [`${question.kind} is not a structured kind`] }
  }
}

/** The first key of `map` outside `ids`, or the first id missing from `map`, as an error. */
function keyError(map: Record<string, unknown>, ids: readonly string[], what: string): string | undefined {
  for (const key of Object.keys(map)) if (!ids.includes(key)) return `unknown ${what} ${key}`
  for (const id of ids) if (!Object.hasOwn(map, id)) return `missing ${what} ${id}`
  return undefined
}

const onStep = (value: number, min: number, step: number) => {
  const steps = (value - min) / step
  return Math.abs(steps - Math.round(steps)) <= STEP_TOLERANCE
}

type Checked = { value: unknown } | { error: string }

function checkValue(spec: Spec, value: unknown): Checked {
  const fail = (error: string): Checked => ({ error })
  if (!isRecord(value)) return fail("value must be an object")
  switch (spec.kind) {
    case "form": {
      const raw = value.fields
      if (!isRecord(raw)) return fail("fields must map field ids to values")
      const missing = keyError(raw, spec.fields.map((field) => field.id), "field")
      if (missing) return fail(missing)
      const fields: Record<string, string | number | boolean> = {}
      for (const field of spec.fields) {
        const entry = raw[field.id]
        switch (field.type) {
          case "text":
            if (typeof entry !== "string") return fail(`field ${field.id} must be a string`)
            if (field.required === true && entry.trim() === "") return fail(`field ${field.id} is required`)
            break
          case "number":
            if (!finite(entry)) return fail(`field ${field.id} must be a finite number`)
            if (field.min !== undefined && entry < field.min) return fail(`field ${field.id} must be >= ${field.min}`)
            if (field.max !== undefined && entry > field.max) return fail(`field ${field.id} must be <= ${field.max}`)
            break
          case "choice":
            if (typeof entry !== "string" || !(field.options ?? []).includes(entry))
              return fail(`field ${field.id} must be one of its options`)
            break
          case "toggle":
            if (typeof entry !== "boolean") return fail(`field ${field.id} must be a boolean`)
            break
        }
        fields[field.id] = entry as string | number | boolean
      }
      return { value: { fields } }
    }
    case "buckets": {
      const raw = value.buckets
      if (!isRecord(raw)) return fail("buckets must map category ids to item ids")
      const missing = keyError(raw, spec.categories.map((category) => category.id), "category")
      if (missing) return fail(missing)
      const itemIDs = spec.items.map((item) => item.id)
      const placed = new Set<string>()
      const buckets: Record<string, string[]> = {}
      for (const category of spec.categories) {
        const list = raw[category.id]
        if (!Array.isArray(list)) return fail(`bucket ${category.id} must be an array of item ids`)
        for (const id of list) {
          if (typeof id !== "string" || !itemIDs.includes(id)) return fail(`unknown item ${JSON.stringify(id)}`)
          if (placed.has(id)) return fail(`item ${id} is placed more than once`)
          placed.add(id)
        }
        buckets[category.id] = [...(list as string[])]
      }
      const unplaced = itemIDs.find((id) => !placed.has(id))
      if (unplaced !== undefined) return fail(`item ${unplaced} is not placed`)
      return { value: { buckets } }
    }
    case "match": {
      const raw = value.pairs
      if (!isRecord(raw)) return fail("pairs must map item ids to target ids")
      const missing = keyError(raw, spec.items.map((item) => item.id), "item")
      if (missing) return fail(missing)
      const targetIDs = spec.targets.map((target) => target.id)
      const used = new Set<string>()
      const pairs: Record<string, string> = {}
      for (const item of spec.items) {
        const target = raw[item.id]
        if (typeof target !== "string" || !targetIDs.includes(target))
          return fail(`unknown target ${JSON.stringify(target)} for ${item.id}`)
        if (used.has(target)) return fail(`target ${target} is matched more than once`)
        used.add(target)
        pairs[item.id] = target
      }
      return { value: { pairs } }
    }
    case "allocate": {
      const raw = value.allocations
      if (!isRecord(raw)) return fail("allocations must map option ids to numbers")
      const missing = keyError(raw, spec.options.map((option) => option.id), "option")
      if (missing) return fail(missing)
      const allocations: Record<string, number> = {}
      let sum = 0
      for (const option of spec.options) {
        const amount = raw[option.id]
        if (!finite(amount) || amount < 0) return fail(`allocation for ${option.id} must be a non-negative finite number`)
        allocations[option.id] = amount
        sum += amount
      }
      if (Math.abs(sum - spec.total) > ALLOCATION_TOLERANCE) return fail(`allocations must add up to ${spec.total} (got ${tidy(sum)})`)
      return { value: { allocations } }
    }
    case "matrix": {
      const raw = value.scores
      if (!isRecord(raw)) return fail("scores must map option ids to criterion scores")
      const missing = keyError(raw, spec.options.map((option) => option.id), "option")
      if (missing) return fail(missing)
      const criterionIDs = spec.criteria.map((criterion) => criterion.id)
      const scores: Record<string, Record<string, number>> = {}
      for (const option of spec.options) {
        const row = raw[option.id]
        if (!isRecord(row)) return fail(`scores for ${option.id} must map criterion ids to numbers`)
        const missingCriterion = keyError(row, criterionIDs, `criterion for ${option.id}:`)
        if (missingCriterion) return fail(missingCriterion)
        const cleaned: Record<string, number> = {}
        for (const id of criterionIDs) {
          const score = row[id]
          if (!finite(score)) return fail(`score ${option.id}.${id} must be a finite number`)
          if (score < spec.min || score > spec.max) return fail(`score ${option.id}.${id} must be within ${spec.min}..${spec.max}`)
          if (!onStep(score, spec.min, spec.step)) return fail(`score ${option.id}.${id} must be on a step of ${spec.step}`)
          cleaned[id] = score
        }
        scores[option.id] = cleaned
      }
      return { value: { scores } }
    }
    case "range": {
      const { min, max } = value
      if (!finite(min) || !finite(max)) return fail("min and max must be finite numbers")
      if (min > max) return fail("min must be <= max")
      if (min < spec.min || max > spec.max) return fail(`range must be within ${spec.min}..${spec.max}`)
      if (!onStep(min, spec.min, spec.step) || !onStep(max, spec.min, spec.step))
        return fail(`min and max must be on a step of ${spec.step}`)
      return { value: { min, max } }
    }
    case "path": {
      const raw = value.paths
      if (!Array.isArray(raw) || raw.length === 0) return fail("paths must be a non-empty array")
      if (!spec.multiple && raw.length > 1) return fail("only one path allowed")
      if (raw.some((path) => typeof path !== "string" || path.trim() === "")) return fail("paths must be non-empty strings")
      const paths = raw as string[]
      if (new Set(paths).size !== paths.length) return fail("paths must be unique")
      if (spec.mode === "files" && paths.some((path) => path.endsWith("/"))) return fail("only files allowed")
      if (spec.mode === "dirs" && paths.some((path) => !path.endsWith("/")))
        return fail("only directories (ending in /) allowed")
      return { value: { paths: [...paths] } }
    }
    case "date":
    case "time":
    case "datetime": {
      const text = value.value
      if (!validTemporal(spec.kind, text)) return fail(`value must be a valid ${TEMPORAL_FORMAT[spec.kind]}`)
      if (spec.min !== undefined && text < spec.min) return fail(`value must be on or after ${spec.min}`)
      if (spec.max !== undefined && text > spec.max) return fail(`value must be on or before ${spec.max}`)
      return { value: { value: text } }
    }
    case "tags": {
      const raw = value.tags
      if (!Array.isArray(raw) || raw.some((tag) => typeof tag !== "string")) return fail("tags must be an array of strings")
      const tags = (raw as string[]).map((tag) => tag.trim())
      if (tags.some((tag) => tag === "")) return fail("tags must not be blank")
      if (new Set(tags).size !== tags.length) return fail("tags must be unique")
      if (spec.min !== undefined && tags.length < spec.min) return fail(`add at least ${spec.min} tags`)
      if (spec.max !== undefined && tags.length > spec.max) return fail(`add at most ${spec.max} tags`)
      return { value: { tags } }
    }
    case "colour": {
      const hex = canonicalHex(value.hex)
      if (hex === undefined) return fail("hex must be #rgb or #rrggbb")
      return { value: { hex } }
    }
  }
}

/** Config and recommendation checks for a structured kind; messages are relative to the question. */
export function validateStructuredQuestion(question: Question): string[] {
  const parsed = parseSpec(question)
  if ("errors" in parsed) return parsed.errors
  const rec = question.recommended
  if (rec === undefined) return []
  const checked = checkValue(parsed.spec, rec)
  if ("error" in checked) return [`recommended: ${checked.error}`]
  if (canon(checked.value) !== canon(rec))
    return [`recommended must be the canonical answer ${JSON.stringify(checked.value)}`]
  return []
}

/** Checks a submitted value against a structured question; returns the canonical value or an error. */
export function validateStructuredValue(question: Question, value: unknown): { value: unknown } | { error: string } {
  const parsed = parseSpec(question)
  if ("errors" in parsed) return { error: `invalid question: ${parsed.errors[0]}` }
  return checkValue(parsed.spec, value)
}

/** A neutral starting value for the UI, valid wherever the question allows one. */
export function structuredDefault(question: Question): unknown {
  const parsed = parseSpec(question)
  if ("errors" in parsed) return undefined
  const spec = parsed.spec
  switch (spec.kind) {
    case "form": {
      const fields: Record<string, string | number | boolean> = {}
      for (const field of spec.fields) {
        if (field.type === "text") fields[field.id] = ""
        else if (field.type === "number")
          fields[field.id] = field.min ?? (field.max !== undefined && field.max < 0 ? field.max : 0)
        else if (field.type === "choice") fields[field.id] = field.options?.[0] ?? ""
        else fields[field.id] = false
      }
      return { fields }
    }
    case "buckets": {
      const buckets: Record<string, string[]> = {}
      spec.categories.forEach((category, index) => {
        buckets[category.id] = index === 0 ? spec.items.map((item) => item.id) : []
      })
      return { buckets }
    }
    case "match": {
      const pairs: Record<string, string> = {}
      spec.items.forEach((item, index) => {
        pairs[item.id] = (spec.targets[index] as StructuredItem).id
      })
      return { pairs }
    }
    case "allocate": {
      const allocations: Record<string, number> = {}
      spec.options.forEach((option, index) => {
        allocations[option.id] = index === 0 ? spec.total : 0
      })
      return { allocations }
    }
    case "matrix": {
      const scores: Record<string, Record<string, number>> = {}
      for (const option of spec.options)
        scores[option.id] = Object.fromEntries(spec.criteria.map((criterion) => [criterion.id, spec.min]))
      return { scores }
    }
    case "range": {
      const top = tidy(spec.min + Math.floor((spec.max - spec.min) / spec.step + STEP_TOLERANCE) * spec.step)
      return { min: spec.min, max: Math.min(spec.max, top) }
    }
    case "path":
      return { paths: [] }
    case "date":
    case "time":
    case "datetime": {
      const fixed = TEMPORAL_DEFAULTS[spec.kind]
      return { value: spec.min ?? (spec.max !== undefined && fixed > spec.max ? spec.max : fixed) }
    }
    case "tags":
      return { tags: [] }
    case "colour":
      return { hex: spec.swatches[0] ?? NEUTRAL_COLOUR }
  }
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value)

/** A readable, possibly multi-line summary of a structured value, keyed by labels. */
export function structuredSummary(question: Question, value: unknown): string {
  const parsed = parseSpec(question)
  if ("errors" in parsed || !isRecord(value)) return pretty(value)
  const spec = parsed.spec
  const labelIn = (items: readonly StructuredItem[], id: string) => items.find((item) => item.id === id)?.label ?? id
  const map = (key: string) => (isRecord(value[key]) ? (value[key] as Record<string, unknown>) : undefined)
  switch (spec.kind) {
    case "form": {
      const fields = map("fields")
      if (!fields) return pretty(value)
      return spec.fields
        .filter((field) => Object.hasOwn(fields, field.id))
        .map((field) => {
          const entry = fields[field.id]
          const shown = field.type === "toggle" ? (entry === true ? "yes" : "no") : String(entry)
          return `${field.label}: ${shown}`
        })
        .join("\n")
    }
    case "buckets": {
      const buckets = map("buckets")
      if (!buckets) return pretty(value)
      return spec.categories
        .map((category) => {
          const list = Array.isArray(buckets[category.id]) ? (buckets[category.id] as unknown[]) : []
          const shown = list.map((id) => labelIn(spec.items, String(id))).join(", ")
          return `${category.label}: ${shown || "(none)"}`
        })
        .join("\n")
    }
    case "match": {
      const pairs = map("pairs")
      if (!pairs) return pretty(value)
      return spec.items
        .filter((item) => Object.hasOwn(pairs, item.id))
        .map((item) => `${item.label} → ${labelIn(spec.targets, String(pairs[item.id]))}`)
        .join("\n")
    }
    case "allocate": {
      const allocations = map("allocations")
      if (!allocations) return pretty(value)
      return spec.options
        .filter((option) => Object.hasOwn(allocations, option.id))
        .map((option) => `${option.label}: ${String(allocations[option.id])}`)
        .join("\n")
    }
    case "matrix": {
      const scores = map("scores")
      if (!scores) return pretty(value)
      return spec.options
        .filter((option) => isRecord(scores[option.id]))
        .map((option) => {
          const row = scores[option.id] as Record<string, unknown>
          const cells = spec.criteria
            .filter((criterion) => Object.hasOwn(row, criterion.id))
            .map((criterion) => `${criterion.label}=${String(row[criterion.id])}`)
          return `${option.label}: ${cells.join(", ")}`
        })
        .join("\n")
    }
    case "range":
      return `${String(value.min)}–${String(value.max)}${spec.unit ? ` ${spec.unit}` : ""}`
    case "path":
      return Array.isArray(value.paths) ? value.paths.map(String).join(", ") : pretty(value)
    case "date":
    case "time":
    case "datetime":
      return String(value.value)
    case "tags":
      return Array.isArray(value.tags) ? value.tags.map(String).join(", ") || "(none)" : pretty(value)
    case "colour":
      return String(value.hex)
  }
}
