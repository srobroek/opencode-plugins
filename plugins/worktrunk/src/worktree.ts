import { stat } from "node:fs/promises"
import { basename } from "node:path"
import type { WorktreeDefinition } from "@opencode/plugin/promise/worktree"
import type { WorktreeCreateInput, WorktreeEntry, WorktreeRemoveInput } from "@opencode/plugin/worktree"

export const STRATEGY_ID = "worktrunk"

/** The result of running one command to completion. */
export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (argv: string[], signal: AbortSignal) => Promise<RunResult>

/** Raised by the strategy; the host turns `forceRequired` into a force confirmation. */
export type StrategyError = (message: string, forceRequired?: boolean) => Error

/** Run `argv` with Bun.spawn, killing it when `signal` aborts. */
export const spawnRunner: Runner = async (argv, signal) => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  signal.throwIfAborted()
  return { code, stdout, stderr }
}

/** `wt switch` arguments that create `<basename(directory)>` from `base` and print JSON. */
export function createArgs(input: { sourceDirectory: string; directory: string; base: string }): string[] {
  return [
    "-C",
    input.sourceDirectory,
    "switch",
    "-y",
    "--create",
    "--no-cd",
    "--base",
    input.base,
    "--format",
    "json",
    branchName(input.directory),
  ]
}

/** The branch a suggested worktree directory becomes: its last path component. */
export function branchName(directory: string): string {
  const name = basename(directory.replace(/[/\\]+$/, ""))
  if (!name || name === "." || name === "..") throw new Error(`cannot derive a branch name from ${directory}`)
  return name
}

/** `wt remove` arguments that remove the worktree at `directory` and wait for it. */
export function removeArgs(input: { directory: string; force: boolean }): string[] {
  return ["-C", input.directory, "remove", "-y", ...(input.force ? ["--force"] : []), "--foreground"]
}

export function listArgs(sourceDirectory: string): string[] {
  return ["-C", sourceDirectory, "list", "--format", "json"]
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/**
 * The JSON value `wt --format json` printed. stdout normally holds only that value,
 * but a hook may write to stdout too, so fall back to the last line that parses.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim()
  try {
    return JSON.parse(text)
  } catch {
    const lines = text.split("\n").reverse()
    for (const line of lines) {
      const candidate = line.trim()
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue
      try {
        return JSON.parse(candidate)
      } catch {}
    }
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The worktree directory in `wt switch --format json` output (`{action, branch, path, base_branch}`). */
export function parseSwitchOutput(stdout: string): { directory: string } {
  const path = record(parseJsonOutput(stdout))?.path
  if (typeof path !== "string" || !path) throw new Error("wt switch printed no worktree path")
  return { directory: path }
}

/** Worktrees in `wt list --format json` output; branch-only rows have no `worktree` and are skipped. */
export function parseListOutput(stdout: string): WorktreeEntry[] {
  const items = record(parseJsonOutput(stdout))?.items
  if (!Array.isArray(items)) throw new Error("wt list printed no items")
  const entries: WorktreeEntry[] = []
  for (const item of items) {
    const worktree = record(record(item)?.worktree)
    const path = worktree?.path
    if (typeof path !== "string" || !path) continue
    entries.push({ directory: path, type: worktree?.main === true ? "root" : "worktree" })
  }
  return entries
}

/** Whether `wt remove` refused because the worktree has uncommitted changes. */
export function removeNeedsForce(output: string): boolean {
  return /uncommitted changes|wt remove --force|is dirty/i.test(stripAnsi(output))
}

/** A one-paragraph error message from a failed command's output. */
export function failureMessage(argv: string[], result: RunResult): string {
  const output = stripAnsi(`${result.stderr}\n${result.stdout}`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("◎"))
    .join("; ")
  // Every argv here is `<binary> -C <directory> <subcommand> ...`.
  const command = [argv[0], argv[3]].filter(Boolean).join(" ")
  return `${command} failed (exit ${result.code})${output ? `: ${output}` : ""}`
}

export type StrategyOptions = {
  run?: Runner
  error: StrategyError
  /** Whether a directory exists; `remove` of a missing directory is a no-op. */
  exists?: (directory: string) => Promise<boolean>
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}

/** The `wt`-backed worktree strategy. */
export function createStrategy(options: StrategyOptions): WorktreeDefinition {
  const run = options.run ?? spawnRunner
  const exists = options.exists ?? directoryExists
  const exec = async (argv: string[], signal: AbortSignal, forceRequired?: (output: string) => boolean) => {
    const result = await run(argv, signal)
    if (result.code !== 0) {
      throw options.error(failureMessage(argv, result), forceRequired?.(`${result.stderr}\n${result.stdout}`))
    }
    return result.stdout
  }
  return {
    id: STRATEGY_ID,
    async create(input: WorktreeCreateInput, { signal }) {
      const base =
        input.branch ??
        (await exec(["git", "-C", input.sourceDirectory, "rev-parse", "--verify", "HEAD"], signal)).trim()
      const stdout = await exec(["wt", ...createArgs({ ...input, base })], signal)
      try {
        return parseSwitchOutput(stdout)
      } catch (error) {
        throw options.error((error as Error).message)
      }
    },
    async remove(input: WorktreeRemoveInput, { signal }) {
      if (!(await exists(input.directory))) return
      await exec(["wt", ...removeArgs(input)], signal, removeNeedsForce)
    },
    async list(sourceDirectory, { signal }) {
      const stdout = await exec(["wt", ...listArgs(sourceDirectory)], signal)
      try {
        return parseListOutput(stdout)
      } catch (error) {
        throw options.error((error as Error).message)
      }
    },
  }
}
