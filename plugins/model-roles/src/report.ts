/**
 * Read-only usage report over the outcome ledger: per tier and per (tier, agent), how many
 * runs ended how, how long they took, what tokens and cost they used. Pure: `summarizeUsage`
 * takes records and a clock, the formatters turn the result into text. A figure the ledger
 * never recorded is `undefined` ("n/a"), never 0: the ledger stores 0 for tokens and cost the
 * host did not report. Records from before the schema version (`v`) stored 0 for usage the host
 * never reported, so their 0 is ambiguous and read as unknown; a version 2 record's 0 is a real 0.
 */

import { BACKGROUND_HOLD_MS } from "@srobroek/opencode-lib/idle-background"
import { LEDGER_MAX_AGE_MS, type OutcomeRecord } from "./ledger.ts"

const DAY_MS = 24 * 60 * 60 * 1000
export const REPORT_DEFAULT_DAYS = LEDGER_MAX_AGE_MS / DAY_MS
/** Agents listed under a tier in the check output. */
export const CHECK_TOP_AGENTS = 3
/** The tier of a record that has none. */
export const NO_TIER = "(none)"

/** A field is present only when some run reported it. */
export type TokenTotals = { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }

export type Stats = {
  /** Runs that ended: unfinished records are not counted. */
  n: number
  succeeded: number
  failed: number
  interrupted: number
  /** Runs the hold timeout ended after an idle with background work: neither a success nor a failure. */
  heldExpired: number
  /** succeeded ÷ the runs that did not end at the hold timeout; undefined when every run did. */
  successRate?: number
  /** Elapsed time of the runs that did not end at the hold timeout, ms; undefined when every run did. */
  ms?: { mean: number; p50: number; p90: number }
  /** Runs that reported tokens, and runs that reported cost: the coverage of the figures below. */
  tokenRuns: number
  costRuns: number
  /** Runs that reported a time to first token, and their median in ms (undefined when none did). */
  firstTokenRuns: number
  firstTokenMs?: number
  /** Over the `tokenRuns` runs; undefined when none reported. */
  tokens?: { total: TokenTotals; mean: TokenTotals; cacheShare?: number }
  /** Summed cost as the host reported it, over the `costRuns` runs; undefined when none reported. */
  cost?: number
  /** Cost of the runs with a known cost, hold-timeout ends aside, ÷ the successes among them; undefined without either. */
  costPerSuccess?: number
  /** Runs a failover moved to another model ÷ n. */
  failoverRate: number
  resumes: number
}

export type AgentUsage = { agent: string } & Stats
export type ArmUsage = { arm: string } & Stats
/** `arms` is set only when some run of the tier recorded an exploration arm. */
export type TierUsage = { tier: string; total: Stats; agents: AgentUsage[]; arms?: ArmUsage[] }
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

/** A usage value, unknown when absent or (on a legacy record) 0. */
const known = (r: OutcomeRecord, value: unknown): number | undefined => {
  const v = finite(value)
  return v === undefined || (r.v === undefined && v === 0) ? undefined : v
}

/** `records` is not empty. */
function stats(records: readonly OutcomeRecord[]): Stats {
  const kinds: Record<Kind, number> = { succeeded: 0, failed: 0, interrupted: 0 }
  const times: number[] = []
  const total: Record<keyof TokenTotals, number> = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  /** Runs that reported each field. */
  const seen: Record<keyof TokenTotals, number> = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  /** Input and cache read over the runs that reported both. */
  let shareInput = 0
  let shareRead = 0
  let tokenRuns = 0
  let cost = 0
  let costRuns = 0
  /** Cost and successes of the runs with a known cost that did not end at the hold timeout. */
  let rateCost = 0
  let costSuccesses = 0
  let heldExpired = 0
  let failovers = 0
  let resumes = 0
  const firstTokens: number[] = []
  for (const r of records) {
    const ttft = finite(r.firstTokenMs)
    if (ttft !== undefined && ttft >= 0) firstTokens.push(ttft)
    const expired = r.heldExpired === true
    const kind = kindOf(r.outcome)
    if (expired) heldExpired++
    else if (kind !== undefined) kinds[kind]++
    if (!expired) times.push(finite(r.ms) ?? 0)
    const values = TOKEN_FIELDS.map(([, field]) => known(r, r[field]))
    if (values.some((v) => v !== undefined)) {
      tokenRuns++
      TOKEN_FIELDS.forEach(([key], i) => {
        const v = values[i]
        if (v === undefined) return
        total[key] += v
        seen[key]++
      })
      const [input, , , read] = values
      if (input !== undefined && read !== undefined) {
        shareInput += input
        shareRead += read
      }
    }
    const c = known(r, r.cost)
    if (c !== undefined) {
      cost += c
      costRuns++
      if (!expired) rateCost += c
      if (!expired && kind === "succeeded") costSuccesses++
    }
    if (r.failedOver === true) failovers++
    resumes += finite(r.resumes) ?? 0
  }
  const n = records.length
  const rated = n - heldExpired
  const sorted = [...times].sort((a, b) => a - b)
  const out: Stats = {
    n,
    ...kinds,
    heldExpired,
    ...(rated > 0
      ? {
          successRate: kinds.succeeded / rated,
          ms: { mean: times.reduce((a, b) => a + b, 0) / rated, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) },
        }
      : {}),
    tokenRuns,
    costRuns,
    firstTokenRuns: firstTokens.length,
    ...(firstTokens.length > 0 ? { firstTokenMs: percentile([...firstTokens].sort((a, b) => a - b), 0.5) } : {}),
    failoverRate: failovers / n,
    resumes,
  }
  if (tokenRuns > 0) {
    const reported = (Object.keys(total) as Array<keyof TokenTotals>).filter((k) => seen[k] > 0)
    const totals: TokenTotals = Object.fromEntries(reported.map((k) => [k, total[k]]))
    const mean: TokenTotals = Object.fromEntries(reported.map((k) => [k, total[k] / seen[k]]))
    const denominator = shareInput + shareRead
    out.tokens = { total: totals, mean, ...(denominator > 0 ? { cacheShare: shareRead / denominator } : {}) }
  }
  if (costRuns > 0) {
    out.cost = cost
    if (costSuccesses > 0) out.costPerSuccess = rateCost / costSuccesses
  }
  return out
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Per-arm stats of the runs that recorded an arm and stayed on it (a failover, an overflow switch or a resume reroute moved the rest to another model); most runs first. */
function armUsage(records: readonly OutcomeRecord[]): ArmUsage[] {
  const byArm = new Map<string, OutcomeRecord[]>()
  for (const r of records) if (r.arm !== undefined && r.failedOver !== true && r.leftArm !== true) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r])
  return [...byArm.entries()].map(([arm, rs]) => ({ arm, ...stats(rs) })).sort((a, b) => b.n - a.n || byName(a.arm, b.arm))
}

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
    .map(([tier, agents]) => {
      const all = [...agents.values()].flat()
      const armed = armUsage(all)
      return {
        tier,
        total: stats(all),
        agents: [...agents.entries()].map(([agent, rs]) => ({ agent, ...stats(rs) })).sort((a, b) => b.n - a.n || byName(a.agent, b.agent)),
        ...(armed.length === 0 ? {} : { arms: armed }),
      }
    })
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
const count = (v: number | undefined): string => (v === undefined ? NA : v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`)
const money = (v: number | undefined) => (v === undefined ? NA : `$${v.toFixed(v >= 1 ? 2 : 3)}`)
const duration = (ms: number | undefined): string =>
  ms === undefined ? NA : (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${+(ms / 1000).toFixed(1)}s` : `${+(ms / 60_000).toFixed(1)}m`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** ` 12/20` when only some runs reported; nothing when all did or none did (n/a says so). */
const coverage = (runs: number, n: number) => (runs > 0 && runs < n ? ` ${runs}/${n}` : "")

/** Median time to first token with its coverage: `1.2s (14/20)`, plain when all runs reported, `n/a` when none did. */
const firstToken = (s: Stats) => `${duration(s.firstTokenMs)}${s.firstTokenRuns > 0 && s.firstTokenRuns < s.n ? ` (${s.firstTokenRuns}/${s.n})` : ""}`

/** How a run the hold timeout ended is named. */
const HELD = `held past ${BACKGROUND_HOLD_MS / 60_000} min`

/** Short text for a list row: runs, success rate, hold-timeout ends, median time, cost. */
export function usageBrief(s: Stats): string {
  const held = s.heldExpired > 0 ? ` · ${s.heldExpired} ${HELD}` : ""
  return `${plural(s.n, "run")} · ${percent(s.successRate)} ok${held} · p50 ${duration(s.ms?.p50)} · ttft ${firstToken(s)} · ${money(s.cost)}${coverage(s.costRuns, s.n)}`
}

/** Every figure of one group, on one line. */
export function usageLine(s: Stats): string {
  const t = s.tokens
  const tokens =
    t === undefined
      ? "tokens n/a"
      : `${coverage(s.tokenRuns, s.n).trim() === "" ? "" : `tokens ${s.tokenRuns}/${s.n}: `}in ${count(t.total.input)} out ${count(t.total.output)} reasoning ${count(t.total.reasoning)} cache r${count(t.total.cacheRead)}/w${count(t.total.cacheWrite)} (${percent(t.cacheShare)} read)`
  return [
    `${plural(s.n, "run")}: ${s.succeeded} ok, ${s.failed} failed, ${s.interrupted} interrupted${s.heldExpired > 0 ? `, ${s.heldExpired} ${HELD}` : ""} (${percent(s.successRate)})`,
    s.ms === undefined ? "time n/a" : `time mean ${duration(s.ms.mean)} p50 ${duration(s.ms.p50)} p90 ${duration(s.ms.p90)}`,
    `ttft ${firstToken(s)}`,
    tokens,
    `cost${coverage(s.costRuns, s.n)} ${money(s.cost)} (${money(s.costPerSuccess)}/success)`,
    `failover ${percent(s.failoverRate)}`,
    plural(s.resumes, "resume"),
  ].join(", ")
}

/** The "Usage per tier" section of `model_roles_check`: a line per tier, then its top agents. */
export function formatUsage(report: UsageReport): string[] {
  const lines = [`Usage per tier (last ${plural(report.days, "day")}):`]
  if (report.tiers.length === 0) return [...lines, "  no finished spawns recorded"]
  for (const { tier, total, agents, arms } of report.tiers) {
    lines.push(`  ${tier}: ${usageLine(total)}`)
    for (const a of arms ?? []) lines.push(`    arm ${a.arm}: ${usageBrief(a)}`)
    for (const a of agents.slice(0, CHECK_TOP_AGENTS)) lines.push(`    - ${a.agent}: ${usageBrief(a)}`)
    if (agents.length > CHECK_TOP_AGENTS) lines.push(`    - ${agents.length - CHECK_TOP_AGENTS} more agents`)
  }
  return lines
}

export type UsageRow = { title: string; value: string; description: string; disabled: true }

/** The `/tiers` detail rows of one tier: its agents, then its exploration arms when it has any. */
export function usageDetailRows(row: TierUsage): UsageRow[] {
  return [
    ...row.agents.map((a) => ({ title: a.agent, value: a.agent, description: usageBrief(a), disabled: true as const })),
    ...(row.arms ?? []).map((a) => ({ title: `arm ${a.arm}`, value: `\u0000arm:${a.arm}`, description: usageBrief(a), disabled: true as const })),
  ]
}
