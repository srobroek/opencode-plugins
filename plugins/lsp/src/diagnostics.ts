/**
 * Pure helpers for the lsp plugin: which files a write call touched, which error
 * diagnostics an lsp-tools-mcp `diagnostics` result reports, which of them are new
 * against a baseline, and the text appended to the tool result.
 */

import { relative } from "node:path"
import { lexicalAbs } from "@srobroek/opencode-lib/shell-write-targets"
import { patchTargets, WRITE_TOOLS, writtenPaths } from "@srobroek/opencode-lib/tool-targets"

/**
 * One error line as lsp-tools-mcp formats it: `error[source] (code) at line:col: message`,
 * with source and code optional. Other severities and status text never match.
 */
const ERROR_LINE = /^error(?:\[[^\]]*\])?(?: \([^)]*\))? at \d+:\d+: /
const POSITION = / at \d+:\d+: /

/**
 * Absolute paths an `edit`, `write` or `patch` call leaves on disk: patch deletes and
 * the source of a patch move are dropped. Other tools touch nothing here.
 */
export function touchedFiles(tool: string, input: unknown, cwd: string): string[] {
  if (!WRITE_TOOLS.has(tool)) return []
  if (tool !== "patch") return writtenPaths(tool, input, cwd)
  const text = (input as { patchText?: unknown } | null)?.patchText
  if (typeof text !== "string") return []
  const gone = new Set<string>()
  const kept: string[] = []
  let previous: string | undefined
  for (const target of patchTargets(text)) {
    const path = lexicalAbs(target.path, cwd)
    if (target.operation === "delete") gone.add(path)
    else if (target.operation === "move" && previous !== undefined) gone.add(previous)
    if (target.operation !== "delete") kept.push(path)
    previous = target.operation === "update" ? path : undefined
  }
  return [...new Set(kept.filter((path) => !gone.has(path)))]
}

/** The error lines of a diagnostics result text, in order. */
export function errorLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => ERROR_LINE.test(line))
}

/** A diagnostic's identity without its position, so errors that only moved stay known. */
export function diagnosticKey(line: string): string {
  return line.replace(POSITION, ": ")
}

/**
 * The errors in `current` that `baseline` does not account for, as a multiset on
 * {@link diagnosticKey}. Without a baseline every error is new.
 */
export function newErrors(baseline: readonly string[] | undefined, current: readonly string[]): string[] {
  if (baseline === undefined) return [...current]
  const known = new Map<string, number>()
  for (const line of baseline) known.set(diagnosticKey(line), (known.get(diagnosticKey(line)) ?? 0) + 1)
  const out: string[] = []
  for (const line of current) {
    const key = diagnosticKey(line)
    const left = known.get(key) ?? 0
    if (left > 0) known.set(key, left - 1)
    else out.push(line)
  }
  return out
}

export type FileErrors = { path: string; errors: readonly string[] }

/**
 * The text appended to an edit result: one header, then each file with its new errors,
 * at most `maxLines` diagnostic lines in total. Empty when no file has new errors.
 */
export function formatReport(files: readonly FileErrors[], cwd: string, maxLines: number): string {
  const withErrors = files.filter((file) => file.errors.length > 0)
  const total = withErrors.reduce((sum, file) => sum + file.errors.length, 0)
  if (total === 0) return ""
  const lines = [`LSP: ${total} new error${total === 1 ? "" : "s"} after this edit`]
  let shown = 0
  for (const file of withErrors) {
    if (shown >= maxLines) break
    const rel = relative(cwd, file.path)
    lines.push(rel === "" || rel.startsWith("..") ? file.path : rel)
    for (const error of file.errors) {
      if (shown >= maxLines) break
      lines.push(`  ${error}`)
      shown++
    }
  }
  if (total > shown) lines.push(`  ... and ${total - shown} more`)
  return lines.join("\n")
}

/** The text a tool result shows: string content, its text parts, or a string output. */
export function toolText(result: unknown): string {
  const value = result as { content?: unknown; output?: unknown } | null | undefined
  const content = value?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n")
  }
  return typeof value?.output === "string" ? value.output : ""
}

/** Settle `work` within `ms`, else `undefined`; aborts `controller` on timeout. */
export async function within<T>(ms: number, controller: AbortController, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`lsp diagnostics exceeded ${ms} ms`))
      resolve(undefined)
    }, ms)
  })
  try {
    return await Promise.race([work.catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}
