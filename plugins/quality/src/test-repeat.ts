import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { capText, median } from "./audit-util.ts"
import { parseJunit, type TestCase } from "./junit.ts"

export type ReportState = "none" | "used" | "missing" | "stale" | "unreadable"

export type RunRecord = {
  run: number
  /** Null when the process was killed (timeout, cancellation) or lost. */
  exitCode: number | null
  outcome: "exited" | "timeout" | "aborted" | "lost"
  seconds: number
  report: ReportState
  cases: TestCase[]
}

export type TestStats = { id: string; passed: number; failed: number; skipped: number; medianSeconds: number; retried: number }

export type RepeatSummary = {
  runs: number
  exitCodes: Array<number | null>
  wallSeconds: { min: number; median: number; max: number }
  reportRuns: number
  badReports: Array<{ run: number; state: ReportState }>
  totalCases: number
  flaky: TestStats[]
  failedEveryRun: TestStats[]
  slowest: TestStats[]
  /** Tests the report says a runner retried and passed within one run (cargo-nextest). */
  retriedInRun: string[]
}

const SLOWEST = 10

/** Fold one run's cases per id: failed beats passed beats skipped; times add up. */
function foldRun(cases: readonly TestCase[]): Map<string, { status: "passed" | "failed" | "skipped"; time: number; retries: number }> {
  const folded = new Map<string, { status: "passed" | "failed" | "skipped"; time: number; retries: number }>()
  for (const c of cases) {
    const status = c.status === "error" || c.status === "failed" ? "failed" : c.status
    const prior = folded.get(c.id)
    if (prior === undefined) {
      folded.set(c.id, { status, time: c.time, retries: c.retries })
      continue
    }
    prior.time += c.time
    prior.retries += c.retries
    if (status === "failed" || (status === "passed" && prior.status === "skipped")) prior.status = status
  }
  return folded
}

/** Aggregate the runs: flaky (passed and failed), always failing, slowest by median time. */
export function summarizeRuns(records: readonly RunRecord[]): RepeatSummary {
  const used = records.filter((r) => r.report === "used")
  const perTest = new Map<string, { passed: number; failed: number; skipped: number; times: number[]; retried: number }>()
  for (const record of used) {
    for (const [id, c] of foldRun(record.cases)) {
      const stats = perTest.get(id) ?? { passed: 0, failed: 0, skipped: 0, times: [], retried: 0 }
      stats[c.status]++
      if (c.status !== "skipped") stats.times.push(c.time)
      if (c.retries > 0) stats.retried++
      perTest.set(id, stats)
    }
  }
  const all: TestStats[] = [...perTest].map(([id, s]) => ({
    id,
    passed: s.passed,
    failed: s.failed,
    skipped: s.skipped,
    medianSeconds: median(s.times),
    retried: s.retried,
  }))
  const byId = (a: TestStats, b: TestStats) => a.id.localeCompare(b.id)
  const seconds = records.map((r) => r.seconds)
  return {
    runs: records.length,
    exitCodes: records.map((r) => r.exitCode),
    wallSeconds: {
      min: seconds.length ? Math.min(...seconds) : 0,
      median: seconds.length ? median(seconds) : 0,
      max: seconds.length ? Math.max(...seconds) : 0,
    },
    reportRuns: used.length,
    badReports: records.filter((r) => r.report !== "used" && r.report !== "none").map((r) => ({ run: r.run, state: r.report })),
    totalCases: all.length,
    flaky: all.filter((t) => t.passed > 0 && t.failed > 0).sort(byId),
    failedEveryRun: all.filter((t) => used.length > 0 && t.failed === used.length).sort(byId),
    slowest: all
      .filter((t) => Number.isFinite(t.medianSeconds))
      .sort((a, b) => b.medianSeconds - a.medianSeconds || byId(a, b))
      .slice(0, SLOWEST),
    retriedInRun: all.filter((t) => t.retried > 0 && t.failed === 0).map((t) => t.id).sort(),
  }
}

const secs = (n: number): string => `${n < 10 ? n.toFixed(2) : n.toFixed(1)}s`

function list<T>(title: string, items: readonly T[], show: (item: T) => string, limit: number): string[] {
  if (items.length === 0) return []
  const lines = [`${title} (${items.length}):`, ...items.slice(0, limit).map((i) => `  ${show(i)}`)]
  if (items.length > limit) lines.push(`  ... +${items.length - limit} more`)
  return lines
}

/** The capped text a `quality_test_repeat` call returns. */
export function formatRepeat(
  summary: RepeatSummary,
  options: { command: string; cwd: string; requested: number; junit: boolean; interrupted?: string },
): string {
  const command = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command
  const codes = summary.exitCodes.map((c) => (c === null ? "killed" : String(c)))
  const failedRuns = summary.exitCodes.filter((c) => c !== 0).length
  const lines = [
    `Ran \`${command}\` ${summary.runs}/${options.requested} times in ${options.cwd}`,
    `exit codes: ${codes.join(" ")} (${summary.runs - failedRuns} passed, ${failedRuns} failed)`,
    `wall time per run: min ${secs(summary.wallSeconds.min)}, median ${secs(summary.wallSeconds.median)}, max ${secs(summary.wallSeconds.max)}`,
  ]
  if (options.interrupted) lines.push(options.interrupted)
  if (new Set(summary.exitCodes).size > 1 && !options.junit)
    lines.push("exit codes differ between runs: the suite is flaky (no junit report to name the tests)")
  if (options.junit) {
    lines.push(`reports used: ${summary.reportRuns}/${summary.runs}; test cases: ${summary.totalCases}`)
    for (const { run, state } of summary.badReports.slice(0, 10))
      lines.push(`run ${run}: report ${state}${state === "stale" ? " (not written during this run)" : ""}`)
    lines.push(
      ...list("flaky (passed and failed)", summary.flaky, (t) => `${t.id}  pass ${t.passed} / fail ${t.failed}`, 15),
      ...list("failed in every run", summary.failedEveryRun, (t) => `${t.id}  fail ${t.failed}`, 15),
      ...list("retried inside a run, then passed", summary.retriedInRun, (id) => id, 5),
      ...list("slowest by median", summary.slowest, (t) => `${secs(t.medianSeconds).padStart(7)}  ${t.id}`, SLOWEST),
    )
    if (summary.reportRuns > 0 && summary.flaky.length === 0 && summary.failedEveryRun.length === 0)
      lines.push("no test both passed and failed; none failed in every run")
  }
  return capText(lines)
}

export type FileMark = { mtimeMs: number; hash: string } | undefined

/** The state of a report file used to tell whether a run rewrote it. Never throws. */
export function markFile(path: string): FileMark {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    return { mtimeMs: stat.mtimeMs, hash: createHash("sha256").update(readFileSync(path)).digest("hex") }
  } catch {
    return undefined
  }
}

/** Whether the file at `after` was written or modified since `before` (by mtime or content). */
export function isFresh(before: FileMark, after: FileMark): boolean {
  if (after === undefined) return false
  return before === undefined || after.mtimeMs !== before.mtimeMs || after.hash !== before.hash
}

/** Classify and read the report one run left. A stale or missing report yields no cases. */
export function readReport(path: string, before: FileMark): { state: ReportState; cases: TestCase[] } {
  const after = markFile(path)
  if (after === undefined) return { state: "missing", cases: [] }
  if (!isFresh(before, after)) return { state: "stale", cases: [] }
  try {
    return { state: "used", cases: parseJunit(readFileSync(path, "utf8")) }
  } catch {
    return { state: "unreadable", cases: [] }
  }
}
