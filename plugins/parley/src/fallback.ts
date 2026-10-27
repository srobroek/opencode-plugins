import { type Answer, normaliseAnswer, type SubmittedAnswer } from "./answers.ts"
import type { Option, Question } from "./questions.ts"

/** Kinds the built-in `question` tool can carry without losing meaning. */
export const FALLBACK_KINDS: ReadonlySet<string> = new Set(["pick_one", "show_options", "pick_many", "confirm", "ask_text"])

export const RECOMMENDED_SUFFIX = " (Recommended)"
export const USE_RECOMMENDED = "Use recommended"
const DEFER = /^(defer|deferred|not sure|skip|later|\?)$/i

/** Shape of one prompt for the built-in `question` tool (`@opencode/schema` Question.Prompt). */
export interface Prompt {
  readonly question: string
  readonly header: string
  readonly options: { readonly label: string; readonly description: string }[]
  readonly multiple?: boolean
}

export function unsupported(questions: readonly Question[]): string[] {
  return questions.filter((question) => !FALLBACK_KINDS.has(question.kind)).map((question) => question.id)
}

const firstParagraph = (body: string | undefined) => body?.trim().split(/\n\s*\n/)[0]?.trim() ?? ""

function optionDescription(question: Question, option: Option): string {
  const parts = [option.description ?? ""]
  if (question.kind === "show_options") {
    const pros = (option.pros ?? []).map((item) => `+${item}`)
    const cons = (option.cons ?? []).map((item) => `−${item}`)
    parts.push([...pros, ...cons].join(" "))
  }
  return parts.filter((part) => part !== "").join(" ") || option.label
}

/** Recommended options first, labelled with the suffix the question tool's own guidance uses. */
function orderedOptions(question: Question, recommended: readonly string[]) {
  const options = question.options ?? []
  const first = options.filter((option) => recommended.includes(option.id))
  const rest = options.filter((option) => !recommended.includes(option.id))
  return [...first, ...rest].map((option) => ({
    label: recommended.includes(option.id) ? `${option.label}${RECOMMENDED_SUFFIX}` : option.label,
    description: optionDescription(question, option),
  }))
}

export function toPrompt(question: Question): Prompt {
  const intro = firstParagraph(question.body) || question.title
  const text = question.rationale ? `${intro}\n\nWhy: ${question.rationale}` : intro
  const header = question.title.length > 30 ? `${question.title.slice(0, 29)}…` : question.title
  const base = { question: text, header }
  switch (question.kind) {
    case "pick_one":
    case "show_options":
      return {
        ...base,
        options: orderedOptions(question, typeof question.recommended === "string" ? [question.recommended] : []),
      }
    case "pick_many":
      return {
        ...base,
        multiple: true,
        options: orderedOptions(question, Array.isArray(question.recommended) ? (question.recommended as string[]) : []),
      }
    case "confirm": {
      const yes = { label: question.yes_label ?? "Yes", description: "Yes" }
      const no = { label: question.no_label ?? "No", description: "No" }
      const options =
        question.recommended === "no"
          ? [{ ...no, label: `${no.label}${RECOMMENDED_SUFFIX}` }, yes]
          : question.recommended === "yes"
            ? [{ ...yes, label: `${yes.label}${RECOMMENDED_SUFFIX}` }, no]
            : [yes, no]
      return { ...base, options }
    }
    default:
      return {
        ...base,
        options:
          typeof question.recommended === "string" && question.recommended !== ""
            ? [{ label: USE_RECOMMENDED, description: question.recommended }]
            : [],
      }
  }
}

const stripSuffix = (label: string) =>
  label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label

function matchOption(question: Question, label: string) {
  const plain = stripSuffix(label).trim().toLowerCase()
  return question.options?.find((option) => option.label.toLowerCase() === plain || option.id.toLowerCase() === plain)
}

/** Maps one `question` tool answer (selected labels or free text) back onto the question. */
export function toSubmitted(question: Question, raw: readonly string[]): SubmittedAnswer {
  const values = raw.map((item) => item.trim()).filter((item) => item !== "")
  const id = question.id
  if (values.length === 0) return { id, status: "deferred", note: "no answer given" }
  if (values.length === 1 && DEFER.test(values[0] as string)) return { id, status: "deferred" }
  switch (question.kind) {
    case "pick_one":
    case "show_options": {
      const value = values[0] as string
      const option = matchOption(question, value)
      if (option) return { id, status: "answered", value: { selected: option.id } }
      if (question.kind === "pick_one" && question.allow_other !== false)
        return { id, status: "answered", value: { other: value } }
      return { id, status: "noted", note: value }
    }
    case "pick_many": {
      const selected: string[] = []
      const free: string[] = []
      for (const value of values) {
        const option = matchOption(question, value)
        if (option) selected.push(option.id)
        else free.push(value)
      }
      const other = free.join(", ")
      if (other !== "" && question.allow_other === false)
        return { id, status: "answered", value: { selected }, note: other }
      return { id, status: "answered", value: other === "" ? { selected } : { selected, other } }
    }
    case "confirm": {
      const value = stripSuffix(values[0] as string).toLowerCase()
      const yes = (question.yes_label ?? "yes").toLowerCase()
      const no = (question.no_label ?? "no").toLowerCase()
      if (value === yes || value === "yes" || value === "y") return { id, status: "answered", value: { choice: "yes" } }
      if (value === no || value === "no" || value === "n") return { id, status: "answered", value: { choice: "no" } }
      return { id, status: "noted", note: values[0] as string }
    }
    default: {
      const value = values.join("\n")
      if (value === USE_RECOMMENDED && typeof question.recommended === "string")
        return { id, status: "accepted" }
      return { id, status: "answered", value: { text: value } }
    }
  }
}

/** Normalises all fallback answers. Entries that still fail validation become notes rather than errors. */
export function fromQuestionTool(questions: readonly Question[], answers: readonly (readonly string[])[]): Answer[] {
  return questions.map((question, index) => {
    const submitted = toSubmitted(question, answers[index] ?? [])
    const result = normaliseAnswer(question, submitted)
    if ("answer" in result) return result.answer
    return { id: question.id, status: "noted", note: (answers[index] ?? []).join(", ") || result.error }
  })
}
