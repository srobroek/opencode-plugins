import { type AnswerStatus, type FileValue, normaliseAnswer, type SubmittedAnswer } from "./answers.ts"
import { DEFAULT_EMOJIS, type Question, recommendedValue, sliderBounds, sliderMid } from "./questions.ts"
import { isStructured, structuredDefault } from "./structured.ts"
import { structuredChoose, structuredEditable, structuredEditText, structuredKeys, structuredRows, structuredSetText, structuredStep } from "./structured-ui.ts"

/** Client-side edit state of one card. `status: "unset"` is left out of the submission (stays pending). */
export interface Draft {
  status: AnswerStatus | "unset"
  value?: unknown
  note: string
  /** Row cursor inside the card (option, yes/no, emoji, …). */
  cursor: number
}

/** Placement uses round membership, not the live subset: hiding a sibling must not make f open a non-existent inline card. */
export function inlineEligible(questions: readonly Question[]): boolean { return questions.length === 1 }

const TEXT_KINDS = new Set(["ask_text", "ask_code", "ask_image", "ask_file"])

export function isTextKind(question: Question) {
  return TEXT_KINDS.has(question.kind)
}

/** Choices shown as rows for a kind, used for the cursor and number keys. */
export function rows(question: Question): string[] {
  if (isStructured(question)) return structuredRows(question).map((row) => row.id)
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
  if (isStructured(question)) return structuredDefault(question)
  const ids = rows(question)
  switch (question.kind) {
    case "pick_many":
      return { selected: [] }
    case "rank":
      return { order: ids }
    case "slider":
      return { value: sliderMid(question) }
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
  const selected = (value as { selected?: unknown; choice?: unknown; decision?: unknown; emoji?: unknown; hex?: unknown } | undefined) ?? {}
  const pointed = [selected.selected, selected.choice, selected.decision, selected.emoji, selected.hex].find(
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

/** Kinds whose choices sit side by side, so ←/→ move between them. */
const HORIZONTAL = new Set(["show_options", "emoji_react"])

export type Arrow = "up" | "down" | "left" | "right"

/** What an arrow key does on a card: move the row cursor, adjust a value, or go to another question. */
export type ArrowAction = { readonly kind: "cursor" | "step" | "question"; readonly delta: number }

/**
 * ↑/↓ move between stacked rows and ←/→ adjust a slider or rating. Side-by-side choices
 * (show_options, emoji_react) swap that: ←/→ move between them and ↑/↓ go to the previous or next
 * question, as they do on cards without rows (slider, text).
 */
export function arrowAction(question: Question, key: Arrow): ArrowAction | undefined {
  const delta = key === "up" || key === "left" ? -1 : 1
  const vertical = key === "up" || key === "down"
  if (question.kind === "date" || question.kind === "datetime" || question.kind === "time") return { kind: "step", delta: delta * (vertical ? question.kind === "time" ? 60 : 7 : 1) }
  if (question.kind === "colour") return { kind: vertical ? "question" : "step", delta }
  if (isStructured(question)) return { kind: vertical ? "cursor" : "step", delta }
  if (HORIZONTAL.has(question.kind)) return { kind: vertical ? "question" : "cursor", delta }
  if (!vertical) return question.kind === "slider" || question.kind === "rate" ? { kind: "step", delta } : undefined
  return rows(question).length > 0 ? { kind: "cursor", delta } : { kind: "question", delta }
}

/** Whether enter in this card's text field inserts a newline instead of saving (code keeps its lines). */
export function enterIsNewline(question: Question, field: "note" | "text") {
  return field === "text" && question.kind === "ask_code"
}

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
  if (isStructured(question)) return structuredChoose(question, draft, index)
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
  if (isStructured(question)) return structuredStep(question, draft, delta)
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
  if (isStructured(question)) { const result = structuredSetText(question, draft, text); return "draft" in result ? result.draft : draft }
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
    case "slider": {
      const parsed = parseSlider(question, text)
      if (parsed === undefined || "error" in parsed) return draft
      return { ...draft, status: "answered", value: parsed }
    }
    default:
      return draft
  }
}

/**
 * Text typed into a slider: a number, snapped to the step and checked against the bounds, or free
 * text when `allow_other` is on. Empty text leaves the value alone (undefined).
 */
export function parseSlider(question: Question, text: string): { value: number } | { other: string } | { error: string } | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  const { min, max, step: size } = sliderBounds(question)
  const unit = question.unit ?? ""
  const bare = unit !== "" && trimmed.endsWith(unit) ? trimmed.slice(0, -unit.length).trim() : trimmed
  const number = Number(bare)
  if (bare !== "" && Number.isFinite(number)) {
    if (number < min || number > max) return { error: `Enter a number from ${min} to ${max}` }
    return { value: Number(clamp(Math.round((number - min) / size) * size + min, min, max).toFixed(10)) }
  }
  const labels = Object.entries(question.labels ?? {}) as [keyof NonNullable<Question["labels"]>, string][]
  const named = labels.find(([, label]) => label.toLowerCase() === trimmed.toLowerCase())?.[0]
  if (named !== undefined) return { value: named === "min" ? min : named === "max" ? max : sliderMid(question) }
  if (question.allow_other === true) return { other: trimmed }
  return { error: `Enter a number from ${min} to ${max}` }
}

/** Whether `e` (edit) opens a text field for this card. */
export function editable(question: Question) {
  return (
    isTextKind(question) || structuredEditable(question) ||
    (question.kind === "pick_one" && question.allow_other !== false) ||
    (question.kind === "pick_many" && question.allow_other !== false) ||
    question.kind === "slider" ||
    question.kind === "review" ||
    question.kind === "show_diff"
  )
}

export function editText(question: Question, draft: Draft): string {
  if (isStructured(question)) return structuredEditText(question, draft)
  const value = draft.value as { text?: string; other?: string; feedback?: string; files?: unknown } | undefined
  if (question.kind === "ask_image" || question.kind === "ask_file") return filePaths(draft).join("\n")
  if (question.kind === "slider") {
    const slider = draft.value as { value?: number; other?: string } | undefined
    return slider?.other ?? (slider?.value === undefined ? "" : String(slider.value))
  }
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

const filesOf = (draft: Draft) => (draft.value as { files?: FileValue[] } | undefined)?.files ?? []

/** Paths of the files typed into a file card (pasted files have none). */
export function filePaths(draft: Draft): string[] {
  return filesOf(draft).flatMap((file) => (file.path === undefined ? [] : [file.path]))
}

/**
 * Puts files on a file card. `typed` replaces the files read from the path field and keeps pasted
 * ones; a pasted file joins them. A single-file card keeps only the newest.
 */
export function setFiles(question: Question, draft: Draft, files: readonly FileValue[], from: "typed" | "pasted"): Draft {
  const kept = from === "typed" ? filesOf(draft).filter((file) => file.path === undefined) : filesOf(draft)
  const all = [...kept, ...files]
  const result = question.multiple === true ? all : all.slice(-1)
  if (result.length === 0) return { ...initialDraft(question), note: draft.note }
  return { ...draft, status: "answered", value: { files: result } }
}

/** The path segment the cursor is completing: the text after the last comma or newline. */
export function completionQuery(text: string): { readonly start: number; readonly query: string } {
  const start = Math.max(text.lastIndexOf(","), text.lastIndexOf("\n")) + 1
  const rest = text.slice(start)
  const lead = rest.length - rest.trimStart().length
  return { start: start + lead, query: rest.trim() }
}

/** Replaces the segment being completed with `choice`. */
export function applyCompletion(text: string, choice: string): string {
  const { start } = completionQuery(text)
  const prefix = text.slice(0, start)
  return `${prefix}${prefix !== "" && !/[\s]$/.test(prefix) ? " " : ""}${choice}`
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic"])

/** Whether a completion candidate fits the card: images for ask_image, `accept` extensions for ask_file. */
export function acceptsPath(question: Question, path: string): boolean {
  if (question.kind === "path") return question.config?.mode === "dirs" ? path.endsWith("/") : question.config?.mode === "files" ? !path.endsWith("/") : true
  if (path.endsWith("/")) return true
  const ext = path.split("/").pop()?.split(".").slice(1).pop()?.toLowerCase() ?? ""
  if (question.kind === "ask_image") return IMAGE_EXTENSIONS.has(ext)
  const accept = (question.accept ?? []).map((item) => item.replace(/^\./, "").toLowerCase())
  return accept.length === 0 || accept.includes(ext)
}

/**
 * Fuzzy score of `query` against `candidate`: every query character must appear in order. Higher is
 * better; matches in the file name, at word starts and in runs score more. Undefined means no match.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  const needle = query.toLowerCase()
  const hay = candidate.toLowerCase()
  if (needle === "") return 0
  const nameStart = hay.lastIndexOf("/", hay.length - 2) + 1
  let score = 0
  let at = -1
  let run = 0
  for (const char of needle) {
    const next = hay.indexOf(char, at + 1)
    if (next < 0) return undefined
    run = next === at + 1 ? run + 1 : 0
    const boundary = next === 0 || "/._- ".includes(hay[next - 1] as string)
    score += 1 + run * 2 + (boundary ? 3 : 0) + (next >= nameStart ? 1 : 0)
    at = next
  }
  return score - hay.length / 100
}

/** Candidates ordered by fuzzy score, best first, at most `limit`. */
export function rankPaths(query: string, candidates: readonly string[], limit = 8): string[] {
  return candidates
    .flatMap((candidate) => {
      const score = fuzzyScore(query, candidate)
      return score === undefined ? [] : [{ candidate, score }]
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.candidate)
}

const PANEL_KEYS: Partial<Record<Question["kind"], string>> = {
  pick_one: "↑/↓ choice · space/1-9 choose · e type your own",
  pick_many: "↑/↓ choice · space/1-9 toggle · e add your own",
  show_options: "←/→ choice · space/1-9 choose",
  confirm: "↑/↓ choice · space/1-9 choose",
  thumbs: "↑/↓ choice · space/1-9 choose",
  rank: "↑/↓ item · J/K or shift+↑/↓ move item",
  rate: "↑/↓ option · ←/→ rating",
  ask_text: "e edit answer",
  ask_code: "e edit code",
  review: "↑/↓ approve/revise · e feedback",
  show_diff: "↑/↓ approve/revise · e feedback",
  emoji_react: "←/→ emoji · space/1-9 choose",
  ask_image: "e type a path (tab completes) · ctrl+v paste image",
  ask_file: "e type paths (tab completes) · ctrl+v paste",
}

function kindKeys(question: Question): string {
  if (isStructured(question)) return structuredKeys(question)
  if (question.kind === "slider")
    return `←/→ adjust · e type a number${question.allow_other === true ? " or your own answer" : ""}`
  return PANEL_KEYS[question.kind] ?? ""
}

const PATH_KINDS = new Set(["ask_image", "ask_file", "path", "tags"])

/**
 * The key hint under a round for the focused card: its own keys first, then the shared ones.
 * `surface` is the full panel (`panel`, `side` when shown beside the session) or the inline `card`.
 */
export function keyHints(
  question: Question | undefined,
  surface: "panel" | "side" | "card",
  editing?: { readonly field: "note" | "text"; readonly enterSaves: boolean; readonly suggestions?: boolean },
  single = false,
): string {
  if (editing) {
    const enter = editing.enterSaves
      ? surface === "card"
        ? "enter submit · shift+enter newline"
        : "enter save · shift+enter newline"
      : "enter newline"
    const paths =
      editing.field === "text" && question && PATH_KINDS.has(question.kind)
        ? editing.suggestions
          ? " · ↑/↓ suggestion · tab complete"
          : " · tab complete"
        : ""
    const paste = editing.field === "text" && question && (question.kind === "ask_image" || question.kind === "ask_file") ? " · ctrl+v paste" : ""
    return `${enter}${paths}${paste} · esc done · ctrl+s submit`
  }
  const own = question ? kindKeys(question) : ""
  const shared =
    surface === "card"
      ? "enter submit · a accept · n note · d defer · f full screen · esc hide · D dismiss"
      : `tab/j/k question · a accept · n note · d defer · ctrl+s submit · f ${single ? "inline card" : surface === "side" ? "full screen" : "side panel"} · esc minimise · D dismiss`
  return `${own === "" ? shared : `${own} · ${shared}`} · y copy`
}

/** "closes in 1m 05s" for the last ten minutes before a round's deadline; nothing earlier, so the default 30 minutes stays quiet. */
export function countdown(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds > 600) return undefined
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `closes in ${minutes > 0 ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`}`
}
