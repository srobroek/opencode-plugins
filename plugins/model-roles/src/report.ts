/**
 * Read-only usage report over the outcome ledger: per tier and per (tier, agent), how many
 * runs ended how, how long they took, what tokens and cost they used. Pure: `summarizeUsage`
 * takes records and a clock, the formatters turn the result into text. A figure the ledger
 * never recorded is `undefined` ("n/a"), never 0: the ledger stores 0 for tokens and cost the
 * host did not report, so a record with all-zero tokens (or zero cost) counts as unreported.
 */

import { LEDGER_MAX_AGE_MS, type OutcomeRecord } from "./ledger.ts"

const DAY_MS = 24 * 60 * 60 * 1000
export const REPORT_DEFAULT_DAYS = LEDGER_MAX_AGE_MS / DAY_MS
/** Agents listed under a tier in the check output. */
export const CHECK_TOP_AGENTS = 3
/** The tier of a record that has none. */
export const NO_TIER = "(none)"

export type TokenTotals = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export type Stats = {
  /** Runs that ended: unfinished records are not counted. */
  n: number
  succeeded: number
  failed: number
  interrupted: number
  /** succeeded ÷ n. */
  successRate: number
  /** Elapsed time of the runs, ms. */
  ms: { mean: number; p50: number; p90: number }
  /** Over the runs that reported tokens; undefined when none did. */
  tokens?: { runs: number; total: TokenTotals; mean: TokenTotals; cacheShare?: number }
  /** Summed cost as the host reported it; undefined when no run reported one. */
  cost?: number
  /** cost ÷ succeeded; undefined without a cost or without a success. */
  costPerSuccess?: number
  /** Runs a failover moved to another model ÷ n. */
  failoverRate: number
  resumes: number
}

export type AgentUsage = { agent: string } & Stats
export type TierUsage = { tier: string; total: Stats; agents: AgentUsage[] }
export type UsageReport = { days: number; tiers: TierUsage[] }

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

type Kind = "succeeded" | "failed" | "interrupted"
const kindOf = (outcome: unknown): Kind | undefined => {
  if (outcome === "succeeded" || outcome === "interrupted") return outcome
  return typeof outcome === "string" && outcome.startsWith("failed:") ? "failed" : undefined
}

/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0

const TOKEN_FIELDS = [
  ["input", "inputTokens"],
  ["output", "outputTokens"],
  ["reasoning", "reasoningTokens"],
  ["cacheRead", "cacheReadTokens"],
  ["cacheWrite", "cacheWriteTokens"],
] as const

/** `records` is not empty. */
function stats(records: readonly OutcomeRecord[]): Stats {
  const kinds: Record<Kind, number> = { succeeded: 0, failed: 0, interrupted: 0 }
  const times: number[] = []
  const total: TokenTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let tokenRuns = 0
  let cost = 0
  let costRuns = 0
  let failovers = 0
  let resumes = 0
  for (const r of records) {
    const kind = kindOf(r.outcome)
    if (kind !== undefined) kinds[kind]++
    times.push(finite(r.ms) ?? 0)
    const values = TOKEN_FIELDS.map(([, field]) => finite(r[field]) ?? 0)
    if (values.some((v) => v > 0)) {
      tokenRuns++
      TOKEN_FIELDS.forEach(([key], i) => {
        total[key] += values[i] ?? 0
      })
    }
    const c = finite(r.cost) ?? 0
    if (c > 0) {
      cost += c
      costRuns++
    }
    if (r.failedOver === true) failovers++
    resumes += finite(r.resumes) ?? 0
  }
  const n = records.length
  const sorted = [...times].sort((a, b) => a - b)
  const out: Stats = {
    n,
    ...kinds,
    successRate: kinds.succeeded / n,
    ms: { mean: times.reduce((a, b) => a + b, 0) / n, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) },
    failoverRate: failovers / n,
    resumes,
  }
  if (tokenRuns > 0) {
    const mean = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v / tokenRuns])) as TokenTotals
    const denominator = total.input + total.cacheRead
    out.tokens = { runs: tokenRuns, total, mean, ...(denominator > 0 ? { cacheShare: total.cacheRead / denominator } : {}) }
  }
  if (costRuns > 0) {
    out.cost = cost
    if (kinds.succeeded > 0) out.costPerSuccess = cost / kinds.succeeded
  }
  return out
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Group the records that ended inside the window by tier and by agent. Tiers sort by name,
 * agents under a tier by runs (most first), then name. `days` defaults to the ledger's retention.
 */
export function summarizeUsage(records: Iterable<OutcomeRecord>, now: number, days?: number): UsageReport {
  const window = days !== undefined && Number.isFinite(days) && days > 0 ? days : REPORT_DEFAULT_DAYS
  const since = now - window * DAY_MS
  const byTier = new Map<string, Map<string, OutcomeRecord[]>>()
  for (const r of records) {
    if (kindOf(r.outcome) === undefined || !(r.at >= since)) continue
    const tier = r.tier ?? NO_TIER
    const agents = byTier.get(tier) ?? new Map<string, OutcomeRecord[]>()
    agents.set(r.agent, [...(agents.get(r.agent) ?? []), r])
    byTier.set(tier, agents)
  }
  const tiers = [...byTier.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([tier, agents]) => ({
      tier,
      total: stats([...agents.values()].flat()),
      agents: [...agents.entries()].map(([agent, rs]) => ({ agent, ...stats(rs) })).sort((a, b) => b.n - a.n || byName(a.agent, b.agent)),
    }))
  return { days: window, tiers }
}

/** Shape check for a report that crossed the RPC. */
export function readUsage(value: unknown): UsageReport | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { tiers, days } = value as { tiers?: unknown; days?: unknown }
  return Array.isArray(tiers) && typeof days === "number" ? (value as UsageReport) : undefined
}

const NA = "n/a"
const percent = (v: number | undefined) => (v === undefined ? NA : `${Math.round(v * 100)}%`)
const count = (v: number): string => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`)
const money = (v: number | undefined) => (v === undefined ? NA : `$${v.toFixed(v >= 1 ? 2 : 3)}`)
const duration = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${+(ms / 1000).toFixed(1)}s` : `${+(ms / 60_000).toFixed(1)}m`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** Short text for a list row: runs, success rate, median time, cost. */
export function usageBrief(s: Stats): string {
  return `${plural(s.n, "run")} · ${percent(s.successRate)} ok · p50 ${duration(s.ms.p50)} · ${money(s.cost)}`
}

/** Every figure of one group, on one line. */
export function usageLine(s: Stats): string {
  const t = s.tokens
  const tokens =
    t === undefined
      ? "tokens n/a"
      : `in ${count(t.total.input)} out ${count(t.total.output)} reasoning ${count(t.total.reasoning)} cache r${count(t.total.cacheRead)}/w${count(t.total.cacheWrite)} (${percent(t.cacheShare)} read)`
  return [
    `${plural(s.n, "run")}: ${s.succeeded} ok, ${s.failed} failed, ${s.interrupted} interrupted (${percent(s.successRate)})`,
    `time mean ${duration(s.ms.mean)} p50 ${duration(s.ms.p50)} p90 ${duration(s.ms.p90)}`,
    tokens,
    `cost ${money(s.cost)} (${money(s.costPerSuccess)}/success)`,
    `failover ${percent(s.failoverRate)}`,
    plural(s.resumes, "resume"),
  ].join(", ")
}

/** The "Usage per tier" section of `model_roles_check`: a line per tier, then its top agents. */
export function formatUsage(report: UsageReport): string[] {
  const lines = [`Usage per tier (last ${plural(report.days, "day")}):`]
  if (report.tiers.length === 0) return [...lines, "  no finished spawns recorded"]
  for (const { tier, total, agents } of report.tiers) {
    lines.push(`  ${tier}: ${usageLine(total)}`)
    for (const a of agents.slice(0, CHECK_TOP_AGENTS)) lines.push(`    - ${a.agent}: ${usageBrief(a)}`)
    if (agents.length > CHECK_TOP_AGENTS) lines.push(`    - ${agents.length - CHECK_TOP_AGENTS} more agents`)
  }
  return lines
}
