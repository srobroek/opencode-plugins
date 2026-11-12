import type { Context } from "@opencode/plugin/promise/plugin"
import { PathError, readReportFile, reportRoots } from "./audit-util.ts"
import { type CoverageFormat, compareCoverage, formatCoverage, parseCoverage } from "./coverage.ts"
import { parseJunit } from "./junit.ts"
import { compareMutation, formatMutation, type MutationFormat, parseMutation } from "./mutation.ts"
import { formatSummary, type RunRecord, summarizeRuns } from "./test-repeat.ts"

export const TEST_SUMMARIZE_TOOL = "quality_test_summarize"
export const TEST_COMPARE_TOOL = "quality_test_compare"
export const MAX_REPORTS = 50

export type TestAuditOptions = { enabled: true } | undefined

/** `testAudit: false` turns both tools off. */
export function parseTestAuditOptions(options: Readonly<Record<string, unknown>>): TestAuditOptions {
  return options.testAudit === false ? undefined : { enabled: true }
}

export type SummarizeInput = { reports: string[]; exitCodes?: Array<number | null> }

/** Validate the tool input; a string result is the error to return. */
export function parseSummarizeInput(input: unknown): SummarizeInput | string {
  const raw = (input ?? {}) as Record<string, unknown>
  const { reports, exitCodes } = raw
  if (!Array.isArray(reports) || reports.length < 1 || reports.length > MAX_REPORTS || reports.some((r) => typeof r !== "string" || r === ""))
    return `reports must be 1 to ${MAX_REPORTS} non-empty paths`
  if (exitCodes !== undefined) {
    if (!Array.isArray(exitCodes) || exitCodes.length !== reports.length || exitCodes.some((c) => c !== null && !Number.isInteger(c)))
      return "exitCodes must be integers or null, one per report"
  }
  return { reports: reports as string[], exitCodes: exitCodes as Array<number | null> | undefined }
}

/** Read and summarize one JUnit report per run, in run order. Pure apart from reading the files. */
export function summarizeReports(root: string, raw: unknown): { content: string; metadata: Record<string, unknown> } {
  const fail = (message: string) => ({ content: `${TEST_SUMMARIZE_TOOL}: ${message}`, metadata: { error: message } })
  const input = parseSummarizeInput(raw)
  if (typeof input === "string") return fail(input)
  const roots = reportRoots(root)
  const records: RunRecord[] = []
  for (const [i, path] of input.reports.entries()) {
    const record: RunRecord = { run: i + 1, exitCode: input.exitCodes?.[i], report: "unreadable", cases: [] }
    try {
      record.cases = parseJunit(readReportFile(root, path, roots))
      record.report = "used"
    } catch (error) {
      if (error instanceof PathError) return fail(`refused: ${error.message}`)
      record.reason = error instanceof Error ? error.message : String(error)
    }
    records.push(record)
  }
  const summary = summarizeRuns(records)
  return { content: formatSummary(summary), metadata: { ...summary } }
}

type CompareInput = { kind?: unknown; baseline?: unknown; candidate?: unknown; format?: unknown }
const COVERAGE_FORMATS = ["lcov", "cobertura", "gocover"]
const MUTATION_FORMATS = ["mutation-testing", "cargo-mutants", "gremlins"]

/** Compare two reports; returns the text and structured summary, or an error text. Pure apart from reading the two files. */
export function compareReports(root: string, input: CompareInput): { content: string; metadata: Record<string, unknown> } {
  const fail = (message: string) => ({ content: `${TEST_COMPARE_TOOL}: ${message}`, metadata: { error: message } })
  if (input.kind !== "coverage" && input.kind !== "mutation") return fail("kind must be coverage or mutation")
  if (typeof input.baseline !== "string" || typeof input.candidate !== "string") return fail("baseline and candidate must be paths")
  const allowed = input.kind === "coverage" ? COVERAGE_FORMATS : MUTATION_FORMATS
  if (input.format !== undefined && !allowed.includes(input.format as string))
    return fail(`format for ${input.kind} must be one of ${allowed.join(", ")}`)
  try {
    const roots = reportRoots(root)
    const baseText = readReportFile(root, input.baseline, roots)
    const candText = readReportFile(root, input.candidate, roots)
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

/** Register both read-only tools unless the options turn them off. Returns the disposer. */
export async function setupTestAudit(ctx: Context, options: TestAuditOptions): Promise<() => Promise<void>> {
  if (options === undefined) return async () => {}
  const root = ctx.location.directory
  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: TEST_SUMMARIZE_TOOL,
      description:
        "Read-only: summarize JUnit XML reports from repeated test runs; flaky, always-failing and slow tests.\n" +
        "Run the test command several times through the shell, writing one JUnit report per run, then pass the paths in run " +
        "order. Reads pytest, Vitest, bun test, gotestsum and cargo-nextest JUnit. Paths must be in the session or OpenCode temp directory.",
      input: {
        type: "object",
        properties: {
          reports: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_REPORTS,
            description: "JUnit XML paths, one per run, in run order",
          },
          exitCodes: {
            type: "array",
            items: { type: ["integer", "null"] },
            description: "Exit code of each run, same length as reports; null when unknown",
          },
        },
        required: ["reports"],
        additionalProperties: false,
      },
      execute: async (raw) => summarizeReports(root, raw),
    })
    editor.add({
      name: TEST_COMPARE_TOOL,
      description:
        "Read-only: compare a baseline and a candidate coverage or mutation report to show lost test protection.\n" +
        "Coverage: LCOV, Cobertura XML, Go cover profile. Mutation: Stryker/mutation-testing-report JSON, cargo-mutants " +
        "outcomes.json, Gremlins JSON. Both paths must be in the session or OpenCode temp directory.",
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
  return async () => {
    await tools.dispose()
  }
}
