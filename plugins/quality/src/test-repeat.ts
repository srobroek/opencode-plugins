import { capText, median } from "./audit-util.ts"
import type { TestCase } from "./junit.ts"

export type ReportState = "used" | "unreadable"

/** One report, in run order. `exitCode` is what the caller observed for that run, when it said. */
export type RunRecord = {
  run: number
  exitCode?: number | null
  report: ReportState
  /** Why the report is unreadable. */
  reason?: string
  cases: TestCase[]
}

export type TestStats = { id: string; passed: number; failed: number; skipped: number; medianSeconds: number; retried: number }

export type RepeatSummary = {
  runs: number
  /** Null when the caller gave no exit codes. */
  exitCodes: Array<number | null> | null
  /** Whether every given exit code is the same; null without exit codes. */
  exitCodesAgree: boolean | null
  /** Runs whose exit code the caller did not know; they take no part in the agreement or counts. */
  exitCodesUnknown: number
  reportRuns: number
  unreadable: Array<{ run: number; reason: string }>
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
  const given = records.some((r) => r.exitCode !== undefined)
  const exitCodes = given ? records.map((r) => r.exitCode ?? null) : null
  const knownCodes = exitCodes?.filter((c): c is number => c !== null)
  const known = knownCodes === undefined || knownCodes.length === 0 ? null : knownCodes
  return {
    runs: records.length,
    exitCodes,
    exitCodesAgree: known === null ? null : new Set(known).size <= 1,
    exitCodesUnknown: exitCodes === null ? 0 : exitCodes.length - (known?.length ?? 0),
    reportRuns: used.length,
    unreadable: records.filter((r) => r.report !== "used").map((r) => ({ run: r.run, reason: r.reason ?? "unreadable" })),
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

/** The capped text a `quality_test_summarize` call returns. */
export function formatSummary(summary: RepeatSummary): string {
  const lines = [`Summarized ${summary.runs} report(s); readable: ${summary.reportRuns}; test cases: ${summary.totalCases}`]
  if (summary.exitCodes !== null) {
    const known = summary.exitCodes.filter((c): c is number => c !== null)
    const failed = known.filter((c) => c !== 0).length
    lines.push(
      `exit codes: ${summary.exitCodes.map((c) => (c === null ? "unknown" : String(c))).join(" ")} (${known.length - failed} zero, ${failed} non-zero, ${summary.exitCodesUnknown} unknown)`,
    )
    if (summary.exitCodesAgree === false) lines.push("exit codes differ between runs: the suite is flaky")
  }
  for (const { run, reason } of summary.unreadable.slice(0, 10)) lines.push(`report ${run}: unreadable (${reason})`)
  lines.push(
    ...list("flaky (passed and failed)", summary.flaky, (t) => `${t.id}  pass ${t.passed} / fail ${t.failed}`, 15),
    ...list("failed in every report", summary.failedEveryRun, (t) => `${t.id}  fail ${t.failed}`, 15),
    ...list("retried inside a run, then passed", summary.retriedInRun, (id) => id, 5),
    ...list("slowest by median", summary.slowest, (t) => `${secs(t.medianSeconds).padStart(7)}  ${t.id}`, SLOWEST),
  )
  if (summary.reportRuns > 0 && summary.flaky.length === 0 && summary.failedEveryRun.length === 0)
    lines.push("no test both passed and failed; none failed in every report")
  return capText(lines)
}
