import { type Answer, describeAnswer, type FileValue, publicAnswer } from "./answers.ts"
import { NOTES_HINT } from "./notes.ts"
import type { Question } from "./questions.ts"
import { type AsMessage, RELOADED_REASON, type RoundResult } from "./rounds.ts"
import { nativeSummary } from "./takeover.ts"

export interface ToolResult extends RoundResult {
  readonly channel?: "tui" | "question"
}

export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

const HINTS: Partial<Record<ToolResult["status"], string>> = {
  open: "The round is open in the parley panel. Call parley_wait to collect the answers.",
  partial: "Some answers are in; the round is still open. Call parley_wait for the rest.",
  timeout:
    "The user did not answer in time and the round closed. Go on with your recommendations for the pending ids and say so, or ask again in a new round if an answer matters.",
  unavailable:
    "No parley UI is available. Ask through the built-in question tool if present, otherwise as a plain markdown round in chat.",
  none: "There is no parley round for this session.",
}

const RELOADED_HINT =
  "Do not ask again and do not use the question tool for this round. Carry on with other work or end your turn; the answers reach you as a message."

const AS_MESSAGE: Record<AsMessage["status"], string> = {
  delivered: "Delivered to you as a session message (read them there; they are not repeated here)",
  sending: "Being delivered to you as a session message (it will arrive; do not ask again)",
  dismissed: "Sent as a session message the user then dismissed (if it reached you, use it; otherwise go on without them)",
}

function asMessageLine(message: AsMessage) {
  return `${AS_MESSAGE[message.status]}: ${message.ids.join(", ")}${message.error ? ` (${message.error})` : ""}`
}

export function summarise(result: ToolResult, questions: readonly Question[]): string {
  const counts = `${result.answers.length} answer${result.answers.length === 1 ? "" : "s"}, ${result.pending.length} pending`
  const head = [
    result.round === undefined ? "Parley" : `Parley round ${result.round}`,
    `: ${result.status}`,
    result.reason === undefined ? "" : ` (${result.reason})`,
    result.status === "unavailable" || result.status === "none" ? "" : ` — ${counts}`,
    result.channel === "question" ? " via question tool" : "",
  ].join("")
  const lines = [head]
  result.answers.forEach((answer, index) => {
    const question = questions.find((candidate) => candidate.id === answer.id)
    lines.push(describe(question, answer, questions.indexOf(question as Question), index))
  })
  if (result.pending.length > 0) lines.push(`Pending: ${result.pending.join(", ")}`)
  if (result.as_message && result.as_message.ids.length > 0) lines.push(asMessageLine(result.as_message))
  const hint = result.reason === RELOADED_REASON ? RELOADED_HINT : HINTS[result.status]
  if (hint) lines.push(hint)
  if (result.answers.some((answer) => answer.note !== undefined)) lines.push(NOTES_HINT)
  return lines.join("\n")
}

function describe(question: Question | undefined, answer: Answer, position: number, fallback: number) {
  return describeAnswer(question, answer, position >= 0 ? position : fallback)
}

export const MAX_INLINE_TEXT = 20_000
const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|typescript))/

export const baseMime = (mime: string) => mime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream"

/**
 * The text that stands for an upload the model cannot get as file content: a text file inlined, any
 * other file handed to `save` and reported by path. Images are left to the caller (undefined).
 */
export function fileNote(answerID: string, file: FileValue, save?: (file: FileValue) => string | undefined): string | undefined {
  if (file.data === undefined) return undefined
  const mime = baseMime(file.mime)
  if (mime.startsWith("image/")) return undefined
  if (TEXT_MIME.test(mime)) {
    const text = Buffer.from(file.data, "base64").toString("utf8")
    const clipped = text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n… (truncated)` : text
    return `--- ${answerID}: ${file.name} ---\n${clipped}`
  }
  const path = file.stored ?? save?.(file)
  return `${answerID}: ${file.name} (${mime}, ${file.size} B)${path ? ` saved to ${path}` : " not forwarded"}`
}

/**
 * Tool `output` (file data stripped) and `content`: the summary, then each upload.
 * Images go to the model as file content, text files are inlined, other files are handed to `save`
 * (which returns a server-side path) because most providers reject arbitrary media types.
 */
export function render(
  result: ToolResult,
  questions: readonly Question[],
  save?: (file: FileValue) => string | undefined,
  format: "parley" | "native" = "parley",
) {
  const output = { ...result, answers: result.answers.map(publicAnswer) }
  const parts: ContentPart[] = []
  const notes: string[] = []
  for (const answer of result.answers) {
    const value = answer.value as { files?: FileValue[] } | undefined
    for (const file of value?.files ?? []) {
      if (file.data === undefined) continue
      const mime = baseMime(file.mime)
      if (mime.startsWith("image/")) {
        parts.push({ type: "file", uri: `data:${mime};base64,${file.data}`, mime, name: file.name })
        continue
      }
      const note = fileNote(answer.id, file, save)
      if (note !== undefined) notes.push(note)
    }
  }
  const head = format === "native" && result.status === "submitted" ? nativeSummary(result, questions) : summarise(result, questions)
  const text = [head, ...notes].join("\n\n")
  const content: string | ContentPart[] = parts.length === 0 ? text : [{ type: "text", text }, ...parts]
  return { output, content }
}
