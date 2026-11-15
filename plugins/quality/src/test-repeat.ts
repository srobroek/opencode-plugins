import { capText, median } from "./audit-util.ts"
import type { FailureKind, TestCase } from "./junit.ts"

export type ReportState = "used" | "unreadable"

/** One report, in run order. `exitCode` is what the caller observed for that run, when it said. */
export type RunRecord = {
  run: number
  exitCode?: number | null
  report: ReportState
  /** Why the report is unreadable. */
  reason?: string
  cases: TestCase[]
  /** How the run was ordered: `default`, `shuffle-files`, `shuffle-tests` or free text. Absent means unshuffled. */
  mode?: string
  /** Size of the JUnit file in bytes. */
  fileBytes?: number
  /** Non-empty lines inside `system-err` elements. */
  stderrLines?: number
}

export type TestStats = {
  id: string
  passed: number
  failed: number
  skipped: number
  medianSeconds: number
  retried: number
  /** Failed runs whose failure message names a timeout. */
  timeouts: number
  /** Failed runs with any other failure: an assertion or an error. */
  otherFailures: number
}

export type OrderDependentStats = TestStats & { failedModes: string[] }

export type RunStats = {
  run: number
  mode?: string
  fileBytes?: number
  stderrLines?: number
  /** Sum of the test durations in the run (CPU-ish time, not wall time). Seconds. */
  testSeconds?: number
  noisy: boolean
}

/** A run is noisy above this many stderr lines or this many report bytes. */
export const NOISY_STDERR_LINES = 1000
export const NOISY_FILE_BYTES = 5_000_000

/** A mode counts as shuffled when its name says shuffle or random; any other mode is the unshuffled baseline. */
export const isShuffledMode = (mode: string | undefined): boolean => mode !== undefined && /shuffle|random/i.test(mode)

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
  /** Mixed outcomes across the unshuffled runs (or across all runs when no mode is given). */
  flaky: TestStats[]
  /** Failed in a shuffled run and never failed in an unshuffled one. Empty without run modes. */
  orderDependent: OrderDependentStats[]
  /** Runs per mode; empty when no run gave a mode. */
  modes: Array<{ mode: string; runs: number }>
  runStats: RunStats[]
  failedEveryRun: TestStats[]
  slowest: TestStats[]
  /** Tests the report says a runner retried and passed within one run (cargo-nextest). */
  retriedInRun: string[]
}

const SLOWEST = 10

/** Fold one run's cases per id: failed beats passed beats skipped; times add up. */
type Folded = { status: "passed" | "failed" | "skipped"; time: number; retries: number; kind?: FailureKind }

function foldRun(cases: readonly TestCase[]): Map<string, Folded> {
  const folded = new Map<string, Folded>()
  for (const c of cases) {
    const status = c.status === "error" || c.status === "failed" ? "failed" : c.status
    const kind = status === "failed" ? (c.failureKind ?? "other") : undefined
    const prior = folded.get(c.id)
    if (prior === undefined) {
      folded.set(c.id, { status, time: c.time, retries: c.retries, kind })
      continue
    }
    prior.time += c.time
    prior.retries += c.retries
    if (status === "failed") prior.kind = prior.kind === "timeout" || kind === "timeout" ? "timeout" : "other"
    if (status === "failed" || (status === "passed" && prior.status === "skipped")) prior.status = status
  }
  return folded
}

type Tally = { passed: number; failed: number; skipped: number; times: number[]; retried: number; timeouts: number; other: number }
const newTally = (): Tally => ({ passed: 0, failed: 0, skipped: 0, times: [], retried: 0, timeouts: 0, other: 0 })

function runStats(record: RunRecord): RunStats {
  const testSeconds = record.report === "used" ? record.cases.reduce((sum, c) => sum + c.time, 0) : undefined
  return {
    run: record.run,
    mode: record.mode,
    fileBytes: record.fileBytes,
    stderrLines: record.stderrLines,
    testSeconds,
    noisy: (record.stderrLines ?? 0) > NOISY_STDERR_LINES || (record.fileBytes ?? 0) > NOISY_FILE_BYTES,
  }
}

/** Aggregate the runs: flaky (passed and failed), always failing, slowest by median time. */
export function summarizeRuns(records: readonly RunRecord[]): RepeatSummary {
  const used = records.filter((r) => r.report === "used")
  const perTest = new Map<string, Tally>()
  const unshuffled = new Map<string, Tally>()
  const failedModes = new Map<string, Set<string>>()
  for (const record of used) {
    const shuffled = isShuffledMode(record.mode)
    for (const [id, c] of foldRun(record.cases)) {
      const stats = perTest.get(id) ?? newTally()
      stats[c.status]++
      if (c.status !== "skipped") stats.times.push(c.time)
      if (c.retries > 0) stats.retried++
      if (c.kind === "timeout") stats.timeouts++
      else if (c.kind === "other") stats.other++
      perTest.set(id, stats)
      if (!shuffled) {
        const base = unshuffled.get(id) ?? newTally()
        base[c.status]++
        unshuffled.set(id, base)
      } else if (c.status === "failed") {
        failedModes.set(id, (failedModes.get(id) ?? new Set()).add(record.mode as string))
      }
    }
  }
  const all: TestStats[] = [...perTest].map(([id, s]) => ({
    id,
    passed: s.passed,
    failed: s.failed,
    skipped: s.skipped,
    medianSeconds: median(s.times),
    retried: s.retried,
    timeouts: s.timeouts,
    otherFailures: s.other,
  }))
  const byId = (a: TestStats, b: TestStats) => a.id.localeCompare(b.id)
  const given = records.some((r) => r.exitCode !== undefined)
  const exitCodes = given ? records.map((r) => r.exitCode ?? null) : null
  const knownCodes = exitCodes?.filter((c): c is number => c !== null)
  const known = knownCodes === undefined || knownCodes.length === 0 ? null : knownCodes
  const modeCounts = new Map<string, number>()
  for (const r of records) if (r.mode !== undefined) modeCounts.set(r.mode, (modeCounts.get(r.mode) ?? 0) + 1)
  // Unshuffled runs decide flakiness; a failure that appears only in shuffled runs is order-dependent.
  const flakyIn = (t: TestStats) => {
    const base = unshuffled.get(t.id)
    return base !== undefined && base.passed > 0 && base.failed > 0
  }
  const orderDependent: OrderDependentStats[] = all
    .filter((t) => failedModes.has(t.id) && (unshuffled.get(t.id)?.failed ?? 0) === 0)
    .map((t) => ({ ...t, failedModes: [...(failedModes.get(t.id) ?? [])].sort() }))
    .sort(byId)
  return {
    runs: records.length,
    exitCodes,
    exitCodesAgree: known === null ? null : new Set(known).size <= 1,
    exitCodesUnknown: exitCodes === null ? 0 : exitCodes.length - (known?.length ?? 0),
    reportRuns: used.length,
    unreadable: records.filter((r) => r.report !== "used").map((r) => ({ run: r.run, reason: r.reason ?? "unreadable" })),
    totalCases: all.length,
    flaky: all.filter(flakyIn).sort(byId),
    orderDependent,
    modes: [...modeCounts].map(([mode, runs]) => ({ mode, runs })),
    runStats: records.map(runStats),
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

const failureSplit = (t: TestStats): string => `fail ${t.failed} (timeout ${t.timeouts}, assertion/error ${t.otherFailures})`

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`

function runLine(r: RunStats): string {
  const parts = [
    r.fileBytes === undefined ? undefined : mb(r.fileBytes),
    r.stderrLines === undefined ? undefined : `${r.stderrLines} stderr lines`,
    r.testSeconds === undefined ? undefined : `summed test time ${secs(r.testSeconds)}`,
  ].filter((p): p is string => p !== undefined)
  return `run ${r.run}${r.mode === undefined ? "" : ` [${r.mode}]`}: ${parts.join(", ")}${r.noisy ? "  NOISY" : ""}`
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
  if (summary.modes.length > 0) lines.push(`run modes: ${summary.modes.map((m) => `${m.mode} x${m.runs}`).join(", ")}`)
  const measured = summary.runStats.filter((r) => r.fileBytes !== undefined || r.stderrLines !== undefined || r.testSeconds !== undefined)
  const noisy = measured.filter((r) => r.noisy)
  const shown = measured.slice(0, 6)
  for (const r of noisy) if (!shown.includes(r)) shown.push(r)
  lines.push(...list("per-run size, stderr and summed test time", shown, runLine, 12))
  if (noisy.length > 0)
    lines.push(
      `noisy runs: ${noisy.map((r) => r.run).join(", ")} (above ${NOISY_STDERR_LINES} stderr lines or ${mb(NOISY_FILE_BYTES)}): check for a missing environment setup or unmocked I/O`,
    )
  lines.push(
    ...list(
      "flaky (passed and failed in unshuffled runs)",
      summary.flaky,
      (t) => `${t.id}  pass ${t.passed} / ${failureSplit(t)}`,
      15,
    ),
    ...list(
      "order-dependent (failed only in shuffled runs)",
      summary.orderDependent,
      (t) => `${t.id}  ${failureSplit(t)}; failed in ${t.failedModes.join(", ")}`,
      15,
    ),
    ...list("failed in every report", summary.failedEveryRun, (t) => `${t.id}  ${failureSplit(t)}`, 15),
    ...list("retried inside a run, then passed", summary.retriedInRun, (id) => id, 5),
    ...list("slowest by median", summary.slowest, (t) => `${secs(t.medianSeconds).padStart(7)}  ${t.id}`, SLOWEST),
  )
  if (summary.reportRuns > 0 && summary.flaky.length === 0 && summary.orderDependent.length === 0 && summary.failedEveryRun.length === 0)
    lines.push("no test both passed and failed; none failed in every report")
  return capText(lines)
}
