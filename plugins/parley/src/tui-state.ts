import { type AnswerStatus, normaliseAnswer, type SubmittedAnswer } from "./answers.ts"
import { DEFAULT_EMOJIS, type Question, recommendedValue, sliderBounds } from "./questions.ts"

/** Client-side edit state of one card. `status: "unset"` is left out of the submission (stays pending). */
export interface Draft {
  status: AnswerStatus | "unset"
  value?: unknown
  note: string
  /** Row cursor inside the card (option, yes/no, emoji, …). */
  cursor: number
}

const TEXT_KINDS = new Set(["ask_text", "ask_code", "ask_image", "ask_file"])

export function isTextKind(question: Question) {
  return TEXT_KINDS.has(question.kind)
}

/** Choices shown as rows for a kind, used for the cursor and number keys. */
export function rows(question: Question): string[] {
  switch (question.kind) {
    case "pick_one":
    case "show_options":
    case "pick_many":
    case "rank":
    case "rate":
      return (question.options ?? []).map((option) => option.id)
    case "confirm":
      return ["yes", "no"]
    case "thumbs":
      return ["up", "down"]
    case "review":
    case "show_diff":
      return ["approve", "revise"]
    case "emoji_react":
      return [...(question.emojis ?? DEFAULT_EMOJIS)]
    default:
      return []
  }
}

function neutral(question: Question): unknown {
  const ids = rows(question)
  switch (question.kind) {
    case "pick_many":
      return { selected: [] }
    case "rank":
      return { order: ids }
    case "slider": {
      const { min, max, step } = sliderBounds(question)
      return { value: Math.round((min + max) / 2 / step) * step }
    }
    case "rate":
      return { ratings: {} }
    case "ask_text":
    case "ask_code":
      return { text: "" }
    default:
      return undefined
  }
}

export function initialDraft(question: Question): Draft {
  const rec = recommendedValue(question)
  const value = rec ?? neutral(question)
  const ids = rows(question)
  const selected = (value as { selected?: unknown; choice?: unknown; decision?: unknown; emoji?: unknown } | undefined) ?? {}
  const pointed = [selected.selected, selected.choice, selected.decision, selected.emoji].find(
    (item) => typeof item === "string" && ids.includes(item),
  ) as string | undefined
  return {
    status: rec === undefined ? "unset" : "answered",
    ...(value === undefined ? {} : { value: structuredClone(value) }),
    note: "",
    cursor: pointed === undefined ? 0 : ids.indexOf(pointed),
  }
}

/** The submission for one card, or undefined to leave the question pending. */
export function toSubmission(question: Question, draft: Draft): SubmittedAnswer | undefined {
  const note = draft.note.trim()
  const withNote = (answer: SubmittedAnswer): SubmittedAnswer => (note === "" ? answer : { ...answer, note })
  switch (draft.status) {
    case "unset":
      return note === "" ? undefined : { id: question.id, status: "noted", note }
    case "deferred":
    case "accepted":
      return withNote({ id: question.id, status: draft.status })
    case "noted":
      return note === "" ? undefined : { id: question.id, status: "noted", note }
    case "answered":
      return withNote({ id: question.id, status: "answered", value: draft.value })
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function moveCursor(question: Question, draft: Draft, delta: number): Draft {
  const count = rows(question).length
  if (count === 0) return draft
  return { ...draft, cursor: clamp(draft.cursor + delta, 0, count - 1) }
}

export function accept(question: Question, draft: Draft): Draft {
  const rec = recommendedValue(question)
  if (rec === undefined) return draft
  return { ...initialDraft(question), note: draft.note, status: "accepted", value: structuredClone(rec) }
}

export function toggleDefer(draft: Draft, question: Question): Draft {
  if (question.allow_defer === false) return draft
  if (draft.status === "deferred") return { ...initialDraft(question), note: draft.note, cursor: draft.cursor }
  return { ...draft, status: "deferred" }
}

export function setNote(draft: Draft, note: string): Draft {
  return { ...draft, note }
}

/** Space/enter on the row under the cursor (or row `index` for number keys). */
export function choose(question: Question, draft: Draft, index = draft.cursor): Draft {
  const ids = rows(question)
  const id = ids[index]
  if (id === undefined) return draft
  const next = { ...draft, cursor: index, status: "answered" as const }
  switch (question.kind) {
    case "pick_one":
    case "show_options":
      return { ...next, value: { selected: id } }
    case "pick_many": {
      const current = ((draft.value as { selected?: string[] } | undefined)?.selected ?? []).slice()
      const at = current.indexOf(id)
      if (at >= 0) current.splice(at, 1)
      else if (question.max === undefined || current.length < question.max) current.push(id)
      return { ...next, value: { selected: ids.filter((option) => current.includes(option)) } }
    }
    case "confirm":
    case "thumbs":
      return { ...next, value: { choice: id } }
    case "review":
    case "show_diff": {
      const feedback = (draft.value as { feedback?: string } | undefined)?.feedback
      return { ...next, value: feedback === undefined ? { decision: id } : { decision: id, feedback } }
    }
    case "emoji_react":
      return { ...next, value: { emoji: id } }
    case "rank":
      return { ...next, value: draft.value ?? { order: ids } }
    default:
      return draft
  }
}

/** Moves the ranked item under the cursor up (-1) or down (+1); the cursor follows it. */
export function rankMove(question: Question, draft: Draft, delta: number): Draft {
  if (question.kind !== "rank") return draft
  const order = ((draft.value as { order?: string[] } | undefined)?.order ?? rows(question)).slice()
  const from = draft.cursor
  const to = clamp(from + delta, 0, order.length - 1)
  if (from === to) return draft
  const [item] = order.splice(from, 1)
  order.splice(to, 0, item as string)
  return { ...draft, status: "answered", cursor: to, value: { order } }
}

/** ←/→ on a slider, or on the rated option under the cursor. */
export function step(question: Question, draft: Draft, delta: number): Draft {
  const { min, max, step: size } = sliderBounds(question)
  const round = (value: number) => Number(clamp(value, min, max).toFixed(10))
  if (question.kind === "slider") {
    const current = (draft.value as { value?: number } | undefined)?.value ?? min
    return { ...draft, status: "answered", value: { value: round(current + delta * size) } }
  }
  if (question.kind === "rate") {
    const id = rows(question)[draft.cursor]
    if (id === undefined) return draft
    const ratings = { ...((draft.value as { ratings?: Record<string, number> } | undefined)?.ratings ?? {}) }
    ratings[id] = round((ratings[id] ?? min - size) + delta * size)
    return { ...draft, status: "answered", value: { ratings } }
  }
  return draft
}

/** Text typed into the card's answer field (ask_text/ask_code, pick_one "other", review feedback). */
export function setText(question: Question, draft: Draft, text: string): Draft {
  switch (question.kind) {
    case "ask_text":
    case "ask_code":
      return { ...draft, status: "answered", value: { text } }
    case "pick_one":
    case "pick_many": {
      const trimmed = text.trim()
      if (question.kind === "pick_one")
        return trimmed === "" ? initialDraft(question) : { ...draft, status: "answered", value: { other: trimmed } }
      const selected = (draft.value as { selected?: string[] } | undefined)?.selected ?? []
      return { ...draft, status: "answered", value: trimmed === "" ? { selected } : { selected, other: trimmed } }
    }
    case "review":
    case "show_diff": {
      const decision = (draft.value as { decision?: string } | undefined)?.decision ?? "revise"
      const trimmed = text.trim()
      return { ...draft, status: "answered", value: trimmed === "" ? { decision } : { decision, feedback: trimmed } }
    }
    default:
      return draft
  }
}

/** Whether `e` (edit) opens a text field for this card. */
export function editable(question: Question) {
  return (
    isTextKind(question) ||
    (question.kind === "pick_one" && question.allow_other !== false) ||
    (question.kind === "pick_many" && question.allow_other === true) ||
    question.kind === "review" ||
    question.kind === "show_diff"
  )
}

export function editText(question: Question, draft: Draft): string {
  const value = draft.value as { text?: string; other?: string; feedback?: string; files?: unknown } | undefined
  if (question.kind === "ask_image" || question.kind === "ask_file") return ""
  return value?.text ?? value?.other ?? value?.feedback ?? ""
}

export function submissions(questions: readonly Question[], drafts: Readonly<Record<string, Draft>>) {
  return questions.flatMap((question) => {
    const draft = drafts[question.id]
    const submitted = draft ? toSubmission(question, draft) : undefined
    return submitted ? [submitted] : []
  })
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
}

export function mimeFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return MIME[ext] ?? "application/octet-stream"
}

/** Splits a path field into paths: one per line, or comma separated. */
export function parsePaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

/** One-line status chip for a card header. */
export function badge(draft: Draft, question?: Question): string {
  if (draft.status === "answered" && question && matchesRecommendation(question, draft)) return "★ recommended"
  switch (draft.status) {
    case "unset":
      return draft.note.trim() === "" ? "· pending" : "✎ noted"
    case "accepted":
      return "✓ accepted"
    case "answered":
      return "● answered"
    case "noted":
      return "✎ noted"
    case "deferred":
      return "⏸ deferred"
  }
}

export function matchesRecommendation(question: Question, draft: Draft): boolean {
  const rec = recommendedValue(question)
  if (rec === undefined || draft.value === undefined) return false
  const submitted = toSubmission(question, draft)
  if (!submitted) return false
  const result = normaliseAnswer(question, { ...submitted, note: undefined } as SubmittedAnswer)
  return "answer" in result && result.answer.status === "accepted"
}

/** Slider bar such as `[━━━━━●─────] 6 ms`. */
export function sliderBar(question: Question, value: number, width = 20): string {
  const { min, max } = sliderBounds(question)
  const filled = Math.round(((value - min) / (max - min)) * width)
  const position = clamp(filled, 0, width)
  return `[${"━".repeat(position)}●${"─".repeat(width - position)}]`
}
