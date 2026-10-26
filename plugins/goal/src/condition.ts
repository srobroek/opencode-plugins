// Exit-code rules ported from Oh My Pi (MIT): src/modes/loop-condition.ts. See NOTICE.
//
// Exit status is authoritative and stdout is ignored. Exit 1 is the only
// "condition is false" status; anything higher (127 not found, 126 not
// executable, 2 syntax error), a timeout or a spawn failure means the condition
// itself is broken, and the loop stops with an explanation instead of looking
// like finished work.

import { existsSync } from "node:fs"

import type { LoopConditionConfig } from "./loop.ts"

export type LoopConditionVerdict =
  | { kind: "continue" }
  | { kind: "halt"; message: string }
  | { kind: "error"; message: string }
  | { kind: "aborted" }

export type ConditionRun =
  | { kind: "exited"; exitCode: number | null; output: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "spawn-error"; error: string }

export const CONDITION_TIMEOUT_MS = 30_000
const PREVIEW_WIDTH = 80

function truncate(text: string, width: number): string {
  const clean = [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0)
      return code < 0x20 || code === 0x7f ? " " : ch
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return clean.length <= width ? clean : `${clean.slice(0, width - 1)}…`
}

function quoteCommand(command: string): string {
  return `\`${truncate(command, PREVIEW_WIDTH)}\``
}

function previewOutput(output: string): string {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line ? truncate(line, PREVIEW_WIDTH) : ""
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`
}

export function describeLoopCondition(condition: LoopConditionConfig): string {
  return `${condition.until ? "until" : "while"} ${quoteCommand(condition.command)} succeeds`
}

/** Map one condition run onto a loop verdict. */
export function conditionVerdict(
  condition: LoopConditionConfig,
  run: ConditionRun,
  timeoutMs = CONDITION_TIMEOUT_MS,
): LoopConditionVerdict {
  const command = quoteCommand(condition.command)
  if (run.kind === "spawn-error") {
    return {
      kind: "error",
      message: `Loop condition ${command} could not run: ${truncate(run.error, PREVIEW_WIDTH)}. Loop mode disabled.`,
    }
  }
  if (run.kind === "timeout") {
    return {
      kind: "error",
      message: `Loop condition ${command} timed out after ${formatTimeout(timeoutMs)}. Loop mode disabled.`,
    }
  }
  if (run.kind === "aborted") return { kind: "aborted" }
  if (run.exitCode === 0) {
    if (!condition.until) return { kind: "continue" }
    return { kind: "halt", message: `Loop condition ${command} is now satisfied. Loop mode disabled.` }
  }
  if (run.exitCode === 1) {
    if (condition.until) return { kind: "continue" }
    return { kind: "halt", message: `Loop condition ${command} no longer holds. Loop mode disabled.` }
  }
  const preview = previewOutput(run.output)
  const detail = preview ? `: ${preview}` : ""
  const status = run.exitCode === null ? "no exit status" : `exit ${run.exitCode}`
  return { kind: "error", message: `Loop condition ${command} failed (${status})${detail}. Loop mode disabled.` }
}

export type ConditionOptions = { cwd: string; timeoutMs?: number; signal?: AbortSignal }

/** Run `command` with `/bin/sh -c`. Never throws. */
export async function runCondition(command: string, options: ConditionOptions): Promise<ConditionRun> {
  const timeoutMs = options.timeoutMs ?? CONDITION_TIMEOUT_MS
  if (!existsSync(options.cwd)) return { kind: "spawn-error", error: `working directory ${options.cwd} does not exist` }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch (error) {
    return { kind: "spawn-error", error: error instanceof Error ? error.message : String(error) }
  }
  let timedOut = false
  let aborted = false
  // Kill the whole process group: sh may fork the command, and an orphaned child keeps the pipes open.
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      proc.kill("SIGKILL")
    }
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, timeoutMs)
      : undefined
  const onAbort = () => {
    aborted = true
    kill()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ])
    if (timedOut) return { kind: "timeout" }
    if (aborted) return { kind: "aborted" }
    return { kind: "exited", exitCode: proc.signalCode ? null : exitCode, output: `${stdout}\n${stderr}` }
  } catch (error) {
    return { kind: "spawn-error", error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

export async function evaluateLoopCondition(
  condition: LoopConditionConfig,
  options: ConditionOptions,
): Promise<LoopConditionVerdict> {
  const run = await runCondition(condition.command, options)
  return conditionVerdict(condition, run, options.timeoutMs ?? CONDITION_TIMEOUT_MS)
}
