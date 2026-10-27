import { type Answer, describeAnswer, type FileValue, publicAnswer } from "./answers.ts"
import type { Question } from "./questions.ts"
import type { RoundResult } from "./rounds.ts"
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
  timeout: "The user has not submitted yet. The round stays open; call parley_wait to keep waiting.",
  unavailable:
    "No parley UI is available. Ask through the built-in question tool if present, otherwise as a plain markdown round in chat.",
  none: "There is no parley round for this session.",
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
  const hint = HINTS[result.status]
  if (hint) lines.push(hint)
  return lines.join("\n")
}

function describe(question: Question | undefined, answer: Answer, position: number, fallback: number) {
  return describeAnswer(question, answer, position >= 0 ? position : fallback)
}

export const MAX_INLINE_TEXT = 20_000
const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|typescript))/

export const baseMime = (mime: string) => mime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream"

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
      if (TEXT_MIME.test(mime)) {
        const text = Buffer.from(file.data, "base64").toString("utf8")
        const clipped = text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n… (truncated)` : text
        notes.push(`--- ${answer.id}: ${file.name} ---\n${clipped}`)
        continue
      }
      const path = save?.(file)
      notes.push(`${answer.id}: ${file.name} (${mime}, ${file.size} B)${path ? ` saved to ${path}` : " not forwarded"}`)
    }
  }
  const head = format === "native" && result.status === "submitted" ? nativeSummary(result, questions) : summarise(result, questions)
  const text = [head, ...notes].join("\n\n")
  const content: string | ContentPart[] = parts.length === 0 ? text : [{ type: "text", text }, ...parts]
  return { output, content }
}
