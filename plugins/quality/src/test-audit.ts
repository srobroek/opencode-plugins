import { readFileSync, statSync } from "node:fs"
import type { Context } from "@opencode/plugin/promise/plugin"
import { supervise } from "@srobroek/opencode-lib/subprocess"
import { PathError, resolveInside } from "./audit-util.ts"
import { type CoverageFormat, compareCoverage, formatCoverage, parseCoverage } from "./coverage.ts"
import { compareMutation, formatMutation, type MutationFormat, parseMutation } from "./mutation.ts"
import { formatRepeat, markFile, type RunRecord, readReport, summarizeRuns } from "./test-repeat.ts"

export const TEST_REPEAT_ACTION = "quality_test_repeat"
export const TEST_COMPARE_TOOL = "quality_test_compare"
export const DEFAULT_RUNS = 5
export const MAX_RUNS = 50
export const DEFAULT_TIMEOUT_SECONDS = 600
export const MAX_TIMEOUT_SECONDS = 3600

type Evaluation = {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  effect: string
  message?: string
}

/**
 * Turn an allowed quality_test_repeat into a prompt: the default policy allows every action, and
 * this runs an arbitrary command up to 50 times. A configured deny never reaches the hook.
 */
export function confirmTestRepeat(evaluation: Evaluation): void {
  if (evaluation.action !== TEST_REPEAT_ACTION || evaluation.effect !== "allow") return
  evaluation.effect = "ask"
  const runs = evaluation.metadata?.runs
  evaluation.message = `Run \`${evaluation.resources.join(" ")}\` ${typeof runs === "number" ? `${runs} times` : "repeatedly"}? The command runs with your permissions and may leave files behind.`
}

export type TestAuditOptions = { confirm: boolean } | undefined

/** `testAudit: false` turns both tools off; `confirmTestRuns` keeps the run prompt unless it is exactly `false`. */
export function parseTestAuditOptions(options: Readonly<Record<string, unknown>>): TestAuditOptions {
  if (options.testAudit === false) return undefined
  return { confirm: options.confirmTestRuns !== false }
}

export type RepeatInput = {
  command: string
  runs: number
  cwd?: string
  junit?: string
  timeoutSeconds: number
}

/** Validate and default the tool input; a string result is the error to return. */
export function parseRepeatInput(input: unknown): RepeatInput | string {
  const raw = (input ?? {}) as Record<string, unknown>
  if (typeof raw.command !== "string" || raw.command.trim() === "") return "command must be a non-empty string"
  const runs = raw.runs ?? DEFAULT_RUNS
  if (!Number.isInteger(runs) || (runs as number) < 1 || (runs as number) > MAX_RUNS) return `runs must be an integer from 1 to ${MAX_RUNS}`
  const timeout = raw.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  if (typeof timeout !== "number" || !(timeout > 0) || timeout > MAX_TIMEOUT_SECONDS)
    return `timeoutSeconds must be a number from 1 to ${MAX_TIMEOUT_SECONDS}`
  for (const key of ["cwd", "junit"])
    if (raw[key] !== undefined && typeof raw[key] !== "string") return `${key} must be a string`
  return {
    command: raw.command,
    runs: runs as number,
    cwd: raw.cwd as string | undefined,
    junit: raw.junit as string | undefined,
    timeoutSeconds: timeout,
  }
}

/** Run `sh -c command` once in its own process group; the whole group dies on timeout or cancellation. */
export async function runOnce(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number | null; outcome: RunRecord["outcome"]; seconds: number }> {
  const started = performance.now()
  const child = Bun.spawn(["sh", "-c", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
  const run = await supervise(child, { timeoutMs, signal, group: true })
  const seconds = (performance.now() - started) / 1000
  return run.kind === "exited"
    ? { exitCode: run.exitCode, outcome: "exited", seconds }
    : { exitCode: null, outcome: run.kind, seconds }
}

/** Run the command `runs` times, reading the JUnit report after each run. Stops early on cancellation. */
export async function repeatRuns(
  input: { command: string; runs: number; cwd: string; junitPath?: string; timeoutSeconds: number },
  signal: AbortSignal | undefined,
  run: typeof runOnce = runOnce,
): Promise<{ records: RunRecord[]; interrupted?: string }> {
  const records: RunRecord[] = []
  for (let i = 1; i <= input.runs; i++) {
    if (signal?.aborted) return { records, interrupted: `cancelled before run ${i}` }
    const before = input.junitPath === undefined ? undefined : markFile(input.junitPath)
    const result = await run(input.command, input.cwd, input.timeoutSeconds * 1000, signal)
    const report =
      input.junitPath === undefined || result.outcome === "aborted"
        ? { state: "none" as const, cases: [] }
        : readReport(input.junitPath, before)
    records.push({ run: i, ...result, report: report.state, cases: report.cases })
    if (result.outcome === "aborted") return { records, interrupted: `cancelled during run ${i}` }
  }
  return { records }
}

type CompareInput = { kind?: unknown; baseline?: unknown; candidate?: unknown; format?: unknown }
const COVERAGE_FORMATS = ["lcov", "cobertura", "gocover"]
const MUTATION_FORMATS = ["mutation-testing", "cargo-mutants", "gremlins"]
const MAX_REPORT_BYTES = 200 * 1024 * 1024

function readInside(root: string, path: string): string {
  const resolved = resolveInside(root, root, path)
  if (statSync(resolved).size > MAX_REPORT_BYTES) throw new Error(`${path} is larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB`)
  return readFileSync(resolved, "utf8")
}

/** Compare two reports; returns the text and structured summary, or an error text. Pure apart from reading the two files. */
export function compareReports(root: string, input: CompareInput): { content: string; metadata: Record<string, unknown> } {
  const fail = (message: string) => ({ content: `${TEST_COMPARE_TOOL}: ${message}`, metadata: { error: message } })
  if (input.kind !== "coverage" && input.kind !== "mutation") return fail("kind must be coverage or mutation")
  if (typeof input.baseline !== "string" || typeof input.candidate !== "string") return fail("baseline and candidate must be paths")
  const allowed = input.kind === "coverage" ? COVERAGE_FORMATS : MUTATION_FORMATS
  if (input.format !== undefined && !allowed.includes(input.format as string))
    return fail(`format for ${input.kind} must be one of ${allowed.join(", ")}`)
  try {
    const baseText = readInside(root, input.baseline)
    const candText = readInside(root, input.candidate)
    if (input.kind === "coverage") {
      const format = input.format as CoverageFormat | undefined
      const result = compareCoverage(parseCoverage(baseText, format, root), parseCoverage(candText, format, root))
      return { content: formatCoverage(result), metadata: { ...result } }
    }
    const format = input.format as MutationFormat | undefined
    const result = compareMutation(parseMutation(baseText, format), parseMutation(candText, format))
    const cap = <T>(list: T[]) => list.slice(0, 200)
    return {
      content: formatMutation(result),
      metadata: {
        ...result,
        lostProtection: cap(result.lostProtection),
        newlyKilled: cap(result.newlyKilled),
        onlyInBaseline: cap(result.onlyInBaseline),
        onlyInCandidate: cap(result.onlyInCandidate),
        lostProtectionCount: result.lostProtection.length,
      },
    }
  } catch (error) {
    if (error instanceof PathError) return fail(`refused: ${error.message}`)
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** Register both tools and, with `confirm`, the evaluate hook, unless the options turn them off. Returns the disposer. */
export async function setupTestAudit(ctx: Context, options: TestAuditOptions): Promise<() => Promise<void>> {
  if (options === undefined) return async () => {}
  const root = ctx.location.directory
  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: TEST_REPEAT_ACTION,
      description:
        "Run one test command several times; report flaky, always-failing and slow tests (JUnit XML optional).\n" +
        "Asks permission first. Each run is `sh -c <command>` in cwd with a timeout. With `junit`, the report is read " +
        "after every run and used only if that run wrote it. Reads pytest, Vitest, bun test, gotestsum and cargo-nextest JUnit.",
      input: {
        type: "object",
        properties: {
          command: { type: "string", description: "Test command, run through sh -c" },
          runs: { type: "integer", minimum: 1, maximum: MAX_RUNS, description: `Number of runs, default ${DEFAULT_RUNS}` },
          cwd: { type: "string", description: "Working directory inside the session directory; default the session directory" },
          junit: { type: "string", description: "JUnit XML path relative to cwd that the command writes on each run" },
          timeoutSeconds: {
            type: "number",
            maximum: MAX_TIMEOUT_SECONDS,
            description: `Per-run timeout, default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}`,
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = parseRepeatInput(raw)
        if (typeof input === "string") return { content: `${TEST_REPEAT_ACTION}: ${input}`, metadata: { error: input } }
        let cwd: string
        let junitPath: string | undefined
        try {
          cwd = resolveInside(root, root, input.cwd)
          if (!statSync(cwd).isDirectory()) throw new PathError(`${input.cwd} is not a directory`)
          junitPath = input.junit === undefined ? undefined : resolveInside(root, cwd, input.junit)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { content: `${TEST_REPEAT_ACTION}: ${message}; no process started`, metadata: { error: message } }
        }
        context.signal.throwIfAborted()
        await ctx.permission.assert({
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
          action: TEST_REPEAT_ACTION,
          resources: [input.command],
          metadata: { runs: input.runs, cwd },
        })
        const { records, interrupted } = await repeatRuns({ ...input, cwd, junitPath }, context.signal)
        const summary = summarizeRuns(records)
        return {
          content: formatRepeat(summary, { command: input.command, cwd, requested: input.runs, junit: junitPath !== undefined, interrupted }),
          metadata: { ...summary, cwd, requestedRuns: input.runs, interrupted: interrupted ?? null },
        }
      },
    })
    editor.add({
      name: TEST_COMPARE_TOOL,
      description:
        "Read-only: compare a baseline and a candidate coverage or mutation report to show lost test protection.\n" +
        "Coverage: LCOV, Cobertura XML, Go cover profile. Mutation: Stryker/mutation-testing-report JSON, cargo-mutants " +
        "outcomes.json, Gremlins JSON. Both paths must be inside the session directory.",
      input: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["coverage", "mutation"], description: "Report kind" },
          baseline: { type: "string", description: "Report before the change; relative to the session directory or absolute" },
          candidate: { type: "string", description: "Report after the change; same rules" },
          format: {
            type: "string",
            enum: [...COVERAGE_FORMATS, ...MUTATION_FORMATS],
            description: "Report format; detected when omitted",
          },
        },
        required: ["kind", "baseline", "candidate"],
        additionalProperties: false,
      },
      execute: async (raw) => compareReports(root, raw as CompareInput),
    })
  })
  const gate = options.confirm ? await ctx.permission.hook("evaluate", confirmTestRepeat) : undefined
  return async () => {
    await gate?.dispose()
    await tools.dispose()
  }
}
