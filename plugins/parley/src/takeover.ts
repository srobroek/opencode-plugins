import { type Answer, describeValue, publicAnswer } from "./answers.ts"
import type { Prompt } from "./fallback.ts"
import { type Question, validateQuestions } from "./questions.ts"
import type { RoundResult } from "./rounds.ts"

/** The built-in question tool's guidance asks models to mark their pick with this suffix. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i

export const DISMISSED = "The user dismissed this question"

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Maps a built-in `question` call onto parley questions (`q1`, `q2`, … with options `o1`, `o2`, …):
 * options become pick_one, or pick_many with `multiple`, both with free text allowed like the
 * built-in form; no options becomes ask_text. Labels ending in "(Recommended)" become the
 * recommendation. Returns errors when parley cannot ask the call as given (e.g. a single option).
 */
export function fromPrompts(prompts: readonly Prompt[]): { questions: Question[] } | { errors: string[] } {
  if (!Array.isArray(prompts) || prompts.length === 0) return { errors: ["questions must be a non-empty array"] }
  const questions = prompts.map((prompt, index): Question => {
    const text = typeof prompt.question === "string" ? prompt.question.trim() : ""
    const header = typeof prompt.header === "string" ? prompt.header.trim() : ""
    const base = { id: `q${index + 1}`, title: header || clip(text, 60) || `Question ${index + 1}`, ...(text ? { body: text } : {}) }
    const raw: Prompt["options"] = Array.isArray(prompt.options) ? prompt.options : []
    if (raw.length === 0) return { ...base, kind: "ask_text" }
    const options = raw.map((option, at) => {
      const label = option.label.replace(RECOMMENDED, "") || option.label
      const description = option.description?.trim()
      return { id: `o${at + 1}`, label, ...(description && description !== label ? { description } : {}) }
    })
    const recommended = raw.flatMap((option, at) => (RECOMMENDED.test(option.label) ? [`o${at + 1}`] : []))
    if (prompt.multiple === true)
      return { ...base, kind: "pick_many", options, allow_other: true, ...(recommended.length > 0 ? { recommended } : {}) }
    return { ...base, kind: "pick_one", options, allow_other: true, ...(recommended[0] ? { recommended: recommended[0] } : {}) }
  })
  const errors = validateQuestions(questions)
  return errors.length > 0 ? { errors } : { questions }
}

/** Whether a `question` call goes to parley: takeover on, parley enabled, a TUI attached for the session. */
export function shouldTakeOver(settings: { questionTool: string; disabled: boolean }, attached: boolean) {
  return settings.questionTool === "takeover" && !settings.disabled && attached
}

/** The built-in tool's answer for one prompt: the chosen option labels as the model wrote them, plus free text. */
export function nativeAnswer(prompt: Prompt, question: Question, answer: Answer | undefined): string[] {
  if (answer === undefined || answer.value === undefined) return []
  const value = answer.value as { selected?: string | string[]; other?: string; text?: string }
  const label = (id: string) => {
    const index = (question.options ?? []).findIndex((option) => option.id === id)
    return prompt.options[index]?.label ?? id
  }
  const selected = value.selected === undefined ? [] : Array.isArray(value.selected) ? value.selected : [value.selected]
  const parts = [...selected.map(label)]
  if (typeof value.other === "string" && value.other.trim() !== "") parts.push(value.other)
  if (typeof value.text === "string" && value.text.trim() !== "") parts.push(value.text)
  return parts
}

interface Entry {
  readonly question: string
  readonly answer: readonly string[]
  readonly note?: string
  readonly deferred: boolean
}

/**
 * The built-in tool's model text, verbatim, followed by parley's extras on their own lines:
 * one `Note on "…": …` per note and a `Deferred: …` line for questions the user put off.
 */
export function nativeText(entries: readonly Entry[]): string {
  const formatted = entries
    .map((entry) => `"${entry.question}"="${entry.answer.length ? entry.answer.join(", ") : "Unanswered"}"`)
    .join(", ")
  const lines = [`User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`]
  for (const entry of entries) if (entry.note) lines.push(`Note on "${entry.question}": ${entry.note}`)
  const deferred = entries.filter((entry) => entry.deferred).map((entry) => `"${entry.question}"`)
  if (deferred.length > 0) lines.push(`Deferred (the user will answer later): ${deferred.join(", ")}`)
  return lines.join("\n")
}

/** A taken-over call's tool result in the built-in question tool's shape (`output`, `content`, `metadata`). */
export function nativeResult(prompts: readonly Prompt[], questions: readonly Question[], result: RoundResult) {
  const answers = questions.map((question, index) =>
    nativeAnswer(prompts[index] as Prompt, question, result.answers.find((answer) => answer.id === question.id)),
  )
  const content = nativeText(
    questions.map((question, index) => {
      const answer = result.answers.find((candidate) => candidate.id === question.id)
      return {
        question: (prompts[index] as Prompt).question,
        answer: answers[index] ?? [],
        ...(answer?.note ? { note: answer.note } : {}),
        deferred: answer?.status === "deferred",
      }
    }),
  )
  return {
    output: { answers },
    content,
    metadata: {
      answers,
      parley: {
        ...(result.round === undefined ? {} : { round: result.round }),
        answers: result.answers.map(publicAnswer),
        pending: result.pending,
      },
    },
  }
}

/** `parley_ask` with `format: "native"`: the question tool's sentence, keyed by question title. */
export function nativeSummary(result: RoundResult, questions: readonly Question[]): string {
  const asked = result.pending.length + result.answers.length
  const scope = asked === 0 ? questions : questions.filter((q) => result.pending.includes(q.id) || result.answers.some((a) => a.id === q.id))
  return nativeText(
    scope.map((question) => {
      const answer = result.answers.find((candidate) => candidate.id === question.id)
      const value = answer?.value as { text?: unknown } | undefined
      const described =
        value === undefined ? "" : typeof value.text === "string" ? value.text : describeValue(question, value)
      return {
        question: question.title,
        answer: described === "" ? [] : [described],
        ...(answer?.note ? { note: answer.note } : {}),
        deferred: answer?.status === "deferred",
      }
    }),
  )
}
