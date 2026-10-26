/**
 * Readers for OpenCode V2 tool results, as seen by `tool.hook("execute.after")`.
 *
 * Verified against OpenCode 2.1.4 (spike opencode-plugins-33m.1): a `shell` result
 * carries its exit code at `output.exit` and again at `metadata.exit`, and its merged
 * stdout and stderr at `output.output`. `content` is either a string or an array of
 * parts, of which `{ type: "text", text }` are the text ones.
 */

import type { Result } from "@opencode/plugin/promise/tool"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

/** The exit code of a `shell` result, or `undefined` when it carries none. */
export function shellExit(result: Result | undefined): number | undefined {
  for (const exit of [record(result?.output)?.exit, result?.metadata?.exit]) {
    if (typeof exit === "number") return exit
  }
  return undefined
}

/** The merged stdout and stderr of a `shell` result, or `undefined` when it carries none. */
export function shellOutput(result: Result | undefined): string | undefined {
  const output = record(result?.output)?.output
  return typeof output === "string" ? output : undefined
}

/** The text the result shows the model: string content, or its text parts joined. */
export function resultText(result: Result | undefined): string {
  const content = result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  return ""
}

/**
 * A copy of `result` with `text` appended to what the model sees. String content gains
 * the text after a newline; array content gains a text part. A result without content
 * starts from its shell output, when it has one, so appending never hides it.
 */
export function appendResultText(result: Result, text: string): Result {
  const content = result.content
  if (Array.isArray(content)) return { ...result, content: [...content, { type: "text", text }] }
  const base = typeof content === "string" ? content : (shellOutput(result) ?? "")
  return { ...result, content: base === "" ? text : `${base}${base.endsWith("\n") ? "" : "\n"}${text}` }
}
