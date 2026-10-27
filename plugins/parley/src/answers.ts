import { DEFAULT_EMOJIS, optionLabel, type Question, recommendedValue, sliderBounds, sliderText } from "./questions.ts"
import { structuredSummary, validateStructuredValue } from "./structured.ts"
import { canonical } from "./value-json.ts"

export { canonical } from "./value-json.ts"

export const ANSWER_STATUSES = ["answered", "accepted", "noted", "deferred"] as const
export type AnswerStatus = (typeof ANSWER_STATUSES)[number]

export const MAX_FILE_BYTES = 10 * 1024 * 1024

export interface FileValue {
  readonly name: string
  readonly mime: string
  readonly size: number
  readonly path?: string
  /** Base64 contents. Kept server-side and sent to the model as file content, never echoed in `output`. */
  readonly data?: string
}

/** What a client submits for one question. */
export interface SubmittedAnswer {
  readonly id: string
  readonly status: AnswerStatus
  readonly value?: unknown
  readonly note?: string
}

export interface Answer {
  readonly id: string
  readonly status: AnswerStatus
  readonly value?: unknown
  readonly note?: string
  readonly accepted_recommendation?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined)

const sameSet = (a: readonly string[], b: readonly string[]) => canonical([...a].sort()) === canonical([...b].sort())

function equalsRecommendation(question: Question, value: unknown): boolean {
  const rec = recommendedValue(question)
  if (rec === undefined || value === undefined) return false
  if (question.kind === "pick_many" && isRecord(value) && isRecord(rec)) {
    return (
      value.other === undefined &&
      Array.isArray(value.selected) &&
      sameSet(value.selected as string[], rec.selected as string[])
    )
  }
  if ((question.kind === "review" || question.kind === "show_diff") && isRecord(value)) {
    return value.decision === (rec as { decision: unknown }).decision && text(value.feedback) === undefined
  }
  return canonical(value) === canonical(rec)
}

/** Checks a value against its question; returns the cleaned value or an error. */
export function validateValue(question: Question, value: unknown): { value: unknown } | { error: string } {
  const fail = (error: string) => ({ error: `${question.id}: ${error}` })
  if (!isRecord(value)) return fail("value must be an object")
  const ids = (question.options ?? []).map((option) => option.id)
  switch (question.kind) {
    case "pick_one":
    case "show_options": {
      const other = text(value.other)
      if (other !== undefined) {
        if (question.kind === "show_options" || question.allow_other === false) return fail("free-text answer not allowed")
        return { value: { other } }
      }
      if (typeof value.selected !== "string" || !ids.includes(value.selected)) return fail("selected must be an option id")
      return { value: { selected: value.selected } }
    }
    case "pick_many": {
      const selected = value.selected ?? []
      if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string" || !ids.includes(id)))
        return fail("selected must be option ids")
      const unique = [...new Set(selected as string[])]
      const other = text(value.other)
      if (other !== undefined && question.allow_other === false) return fail("free-text answer not allowed")
      const count = unique.length + (other === undefined ? 0 : 1)
      if (question.min !== undefined && count < question.min) return fail(`pick at least ${question.min}`)
      if (question.max !== undefined && count > question.max) return fail(`pick at most ${question.max}`)
      return { value: other === undefined ? { selected: unique } : { selected: unique, other } }
    }
    case "confirm":
    case "thumbs": {
      const allowed = question.kind === "confirm" ? ["yes", "no"] : ["up", "down"]
      if (typeof value.choice !== "string" || !allowed.includes(value.choice))
        return fail(`choice must be ${allowed.join(" or ")}`)
      return { value: { choice: value.choice } }
    }
    case "rank": {
      const order = value.order
      if (!Array.isArray(order) || order.length !== ids.length || !sameSet(order as string[], ids))
        return fail("order must list every option id exactly once")
      return { value: { order: [...order] } }
    }
    case "slider": {
      const { min, max, step } = sliderBounds(question)
      const other = text(value.other)
      if (other !== undefined) {
        if (question.allow_other !== true) return fail("free-text answer not allowed")
        return { value: { other } }
      }
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) return fail("value must be a number")
      if (value.value < min || value.value > max) return fail(`value must be within ${min}..${max}`)
      const snapped = Number((Math.round((value.value - min) / step) * step + min).toFixed(10))
      return { value: { value: Math.min(max, snapped) } }
    }
    case "rate": {
      const { min, max } = sliderBounds(question)
      if (!isRecord(value.ratings)) return fail("ratings must map option ids to numbers")
      const ratings: Record<string, number> = {}
      for (const [id, rating] of Object.entries(value.ratings)) {
        if (!ids.includes(id)) return fail(`unknown option ${id}`)
        if (typeof rating !== "number" || rating < min || rating > max)
          return fail(`rating for ${id} must be within ${min}..${max}`)
        ratings[id] = rating
      }
      return { value: { ratings } }
    }
    case "ask_text":
    case "ask_code":
      if (typeof value.text !== "string") return fail("text must be a string")
      return { value: { text: value.text } }
    case "review":
    case "show_diff": {
      if (value.decision !== "approve" && value.decision !== "revise") return fail("decision must be approve or revise")
      const feedback = text(value.feedback)
      return { value: feedback === undefined ? { decision: value.decision } : { decision: value.decision, feedback } }
    }
    case "emoji_react": {
      const allowed = question.emojis ?? DEFAULT_EMOJIS
      if (typeof value.emoji !== "string" || !allowed.includes(value.emoji)) return fail("emoji must be one of the offered")
      return { value: { emoji: value.emoji } }
    }
    case "ask_image":
    case "ask_file": {
      const files = value.files
      if (!Array.isArray(files) || files.length === 0) return fail("files must be a non-empty array")
      if (question.multiple !== true && files.length > 1) return fail("only one file allowed")
      const cleaned: FileValue[] = []
      for (const file of files) {
        if (!isRecord(file) || typeof file.name !== "string" || typeof file.data !== "string")
          return fail("each file needs name and base64 data")
        const size = Buffer.byteLength(file.data, "base64")
        if (size > MAX_FILE_BYTES) return fail(`${file.name} is larger than ${MAX_FILE_BYTES} bytes`)
        const mime = typeof file.mime === "string" ? file.mime : "application/octet-stream"
        if (question.kind === "ask_image" && !mime.startsWith("image/")) return fail(`${file.name} is not an image`)
        cleaned.push({
          name: file.name,
          mime,
          size,
          data: file.data,
          ...(typeof file.path === "string" ? { path: file.path } : {}),
        })
      }
      return { value: { files: cleaned } }
    }
    case "form":
    case "buckets":
    case "match":
    case "allocate":
    case "matrix":
    case "range":
    case "path":
    case "date":
    case "time":
    case "datetime":
    case "tags":
    case "colour": {
      const checked = validateStructuredValue(question, value)
      return "error" in checked ? fail(checked.error) : checked
    }
  }
}

/** Turns a client submission into a stored answer, filling and checking values. */
export function normaliseAnswer(question: Question, submitted: SubmittedAnswer): { answer: Answer } | { error: string } {
  const note = text(submitted.note)
  const withNote = (answer: Answer): { answer: Answer } => ({
    answer: note === undefined ? answer : { ...answer, note },
  })
  switch (submitted.status) {
    case "deferred":
      if (question.allow_defer === false) return { error: `${question.id}: cannot be deferred` }
      return withNote({ id: question.id, status: "deferred" })
    case "noted":
      if (note === undefined) return { error: `${question.id}: a note is required` }
      return withNote({ id: question.id, status: "noted" })
    case "accepted": {
      const rec = recommendedValue(question)
      if (rec === undefined) return { error: `${question.id}: has no recommendation to accept` }
      return withNote({ id: question.id, status: "accepted", value: rec, accepted_recommendation: true })
    }
    case "answered": {
      if (submitted.value === undefined) return { error: `${question.id}: answered without a value` }
      const checked = validateValue(question, submitted.value)
      if ("error" in checked) return checked
      const accepted = equalsRecommendation(question, checked.value)
      return withNote({
        id: question.id,
        status: accepted ? "accepted" : "answered",
        value: checked.value,
        accepted_recommendation: accepted,
      })
    }
    default:
      return { error: `${question.id}: unknown status ${JSON.stringify(submitted.status)}` }
  }
}

/** The answer as returned in tool `output`: file contents are stripped (they travel as file content). */
export function publicAnswer(answer: Answer): Answer {
  if (!isRecord(answer.value) || !Array.isArray(answer.value.files)) return answer
  const files = (answer.value.files as FileValue[]).map(({ data: _data, ...file }) => file)
  return { ...answer, value: { files } }
}

/** One-line human summary of a value, used in the transcript text. */
export function describeValue(question: Question, value: unknown): string {
  if (!isRecord(value)) return ""
  const label = (id: string) => optionLabel(question, id)
  switch (question.kind) {
    case "pick_one":
    case "show_options":
      return value.other !== undefined ? `other: ${String(value.other)}` : label(String(value.selected))
    case "pick_many": {
      const parts = ((value.selected as string[]) ?? []).map(label)
      if (value.other !== undefined) parts.push(`other: ${String(value.other)}`)
      return parts.length === 0 ? "(none)" : parts.join(", ")
    }
    case "confirm":
      return value.choice === "yes" ? (question.yes_label ?? "yes") : (question.no_label ?? "no")
    case "thumbs":
      return value.choice === "up" ? "👍" : "👎"
    case "rank":
      return ((value.order as string[]) ?? []).map(label).join(" > ")
    case "slider":
      if (value.other !== undefined) return `other: ${String(value.other)}`
      return typeof value.value === "number" ? sliderText(question, value.value) : String(value.value)
    case "rate":
      return Object.entries((value.ratings as Record<string, number>) ?? {})
        .map(([id, rating]) => `${label(id)}=${rating}`)
        .join(", ")
    case "ask_text":
    case "ask_code":
      return JSON.stringify(value.text)
    case "review":
    case "show_diff":
      return value.feedback === undefined
        ? String(value.decision)
        : `${String(value.decision)}: ${String(value.feedback)}`
    case "emoji_react":
      return String(value.emoji)
    case "ask_image":
    case "ask_file":
      return ((value.files as FileValue[]) ?? []).map((file) => `${file.name} (${file.mime}, ${file.size} B)`).join(", ")
    case "form":
    case "buckets":
    case "match":
    case "allocate":
    case "matrix":
    case "range":
    case "path":
    case "date":
    case "time":
    case "datetime":
    case "tags":
    case "colour":
      return structuredSummary(question, value)
  }
}

export function describeAnswer(question: Question | undefined, answer: Answer, index: number): string {
  const head = `Q${index + 1} ${answer.id} [${answer.status}]`
  const value = question && answer.value !== undefined ? ` → ${describeValue(question, answer.value)}` : ""
  const note = answer.note === undefined ? "" : ` (note: ${answer.note})`
  return `${head}${value}${note}`
}
