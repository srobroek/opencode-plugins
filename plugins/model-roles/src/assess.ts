/**
 * Assessment of the exploration evidence: per tier and agent, whether an explored arm beats the
 * control by enough to recommend it, whether an adopted control should be rolled back, or to keep
 * the control. Advisory only: nothing here writes config; the user adopts through `/tiers`. All
 * pure: `assessmentStats` turns ledger records into per-arm sums, `assess` decides from the sums.
 *
 * Estimator. Each scored run i of arm a has reward r_i in {0, 1} and propensity p_i (the logged
 * probability of the arm drawn), weight w_i = 1/p_i. The arm's rate is the self-normalised
 * inverse-propensity (Hájek) estimate R_a = Σ w_i r_i / Σ w_i, so runs drawn under a smaller ε
 * (rarer draws) count for more, and the control's 1 − ε share of draws does not decide how its
 * runs weigh against an arm's. The interval uses the Kish effective size n_a = (Σ w_i)² / Σ w_i²,
 * which equals the run count when every weight is the same. The difference R_arm − R_control
 * gets Newcombe's hybrid score interval (Newcombe 1998, method 10) from the two Wilson score
 * intervals at 95%. `minN` applies to both the scored runs and the effective size, rounded down. Cost per success is
 * Σ w_i c_i / Σ w_i r_i over the scored runs that reported a cost.
 */

import { vendorOf } from "./catalog.ts"
import { isReviewerAgent } from "./explore.ts"
import type { OutcomeRecord } from "./ledger.ts"
import { money, NO_TIER, REPORT_DEFAULT_DAYS } from "./report.ts"
import { parseCandidate } from "./resolve.ts"

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054
export const ADOPTIONS_KEY = "adoptions"
export const MAX_ADOPTIONS = 50
const DAY_MS = 24 * 60 * 60 * 1000

export type AssessPolicy = { minN: number; margin: number; costTolerance: number }

/** The weighted sums of one arm's scored runs. */
export type ArmSample = {
  arm: string
  /** Runs with a reward signal. */
  n: number
  sumW: number
  sumW2: number
  sumWR: number
  /** Scored runs that reported a cost, and their Σ w·cost and Σ w·reward. */
  costRuns: number
  sumWCost: number
  sumWRCost: number
}

/** A `/tiers` adoption: `tier` was changed so that `to` became the control in place of `from`. */
export type Adoption = { tier: string; agent?: string; from: string; to: string; at: number }

export type GroupStats = {
  tier: string
  agent: string
  /** The current control: the first eligible arm of the group's newest explored run. */
  control: string
  arms: ArmSample[]
  /** Explored runs without a reward signal: left out of every rate. */
  unscored: number
  /** The tier's latest adoption, when there is one. */
  adoption?: Adoption
}

export type Evidence = {
  arm: string
  n: number
  controlN: number
  armRate: number
  controlRate: number
  diff: number
  lower: number
  upper: number
  /** Undefined when no scored run reported a cost; Infinity with cost but no success. */
  armCostPerSuccess?: number
  controlCostPerSuccess?: number
}

export type Assessment =
  | { decision: "recommend" | "rollback"; control: string; arm: string; evidence: Evidence; unscored: number }
  | { decision: "keep"; reason: "runs" | "interval" | "cost"; control: string; n: number; minN: number; margin: number; evidence?: Evidence; unscored: number }

/** Wilson score interval of a proportion `p` over `n` trials. */
export function wilson(p: number, n: number, z = Z95): { lower: number; upper: number } {
  const z2 = z * z
  const denominator = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) }
}

/** Newcombe's hybrid score interval for p1 − p2 (method 10). */
export function newcombe(p1: number, n1: number, p2: number, n2: number, z = Z95): { lower: number; upper: number } {
  const a = wilson(p1, n1, z)
  const b = wilson(p2, n2, z)
  const d = p1 - p2
  return {
    lower: d - Math.sqrt((p1 - a.lower) ** 2 + (b.upper - p2) ** 2),
    upper: d + Math.sqrt((a.upper - p1) ** 2 + (p2 - b.lower) ** 2),
  }
}

const rateOf = (s: ArmSample) => s.sumWR / s.sumW
const effective = (s: ArmSample) => (s.sumW * s.sumW) / s.sumW2
/** The runs that count toward `minN`: the scored runs, capped by Kish's effective size (rounded down, with float slack). */
const counted = (s: ArmSample) => Math.min(s.n, Math.floor(effective(s) + 1e-9))
const costPerSuccess = (s: ArmSample): number | undefined => (s.costRuns === 0 ? undefined : s.sumWRCost === 0 ? Number.POSITIVE_INFINITY : s.sumWCost / s.sumWRCost)

/** The comparison of an arm with the control: Hájek rates, the Newcombe 95% interval of the difference over Kish sizes, cost per success. */
export function evidenceOf(arm: ArmSample, control: ArmSample): Evidence {
  const armRate = rateOf(arm)
  const controlRate = rateOf(control)
  const { lower, upper } = newcombe(armRate, effective(arm), controlRate, effective(control))
  const armCost = costPerSuccess(arm)
  const controlCost = costPerSuccess(control)
  return {
    arm: arm.arm,
    n: arm.n,
    controlN: control.n,
    armRate,
    controlRate,
    diff: armRate - controlRate,
    lower,
    upper,
    ...(armCost === undefined ? {} : { armCostPerSuccess: armCost }),
    ...(controlCost === undefined ? {} : { controlCostPerSuccess: controlCost }),
  }
}

/** Unknown cost on either side fails. */
const costOk = (e: Evidence, tolerance: number) =>
  e.armCostPerSuccess !== undefined && e.controlCostPerSuccess !== undefined && e.armCostPerSuccess <= e.controlCostPerSuccess * (1 + tolerance)

const best = (list: readonly Evidence[]) => [...list].sort((a, b) => b.lower - a.lower)[0]

/**
 * The decision for one tier and agent. An arm qualifies when it and the control each have at
 * least `minN` scored runs and a Kish effective size of at least `minN`, the Newcombe 95% lower
 * bound of (arm rate − control rate) is above `margin`, and its cost per success is at most the
 * control's × (1 + `costTolerance`).
 * Rollback: the tier's latest adoption made the current control (its `to`), and the control it
 * replaced (its `from`) now qualifies against it; without that adoption there is no rollback and
 * the previous control is an arm like any other. Otherwise recommend the qualifying arm with the
 * highest lower bound, or keep, with the reason: too few runs, the interval does not clear the
 * margin, or cost.
 */
export function assess(stats: GroupStats, policy: AssessPolicy): Assessment {
  const { control, unscored } = stats
  const controlSample = stats.arms.find((s) => s.arm === control)
  const others = stats.arms.filter((s) => s.arm !== control && s.n > 0)
  const controlN = controlSample === undefined ? 0 : counted(controlSample)
  const ready = others.filter((s) => counted(s) >= policy.minN)
  if (controlSample === undefined || controlN < policy.minN || ready.length === 0) {
    const most = Math.max(0, ...others.map(counted))
    return { decision: "keep", reason: "runs", control, n: Math.min(controlN, most), minN: policy.minN, margin: policy.margin, unscored }
  }
  const evidence = ready.map((s) => evidenceOf(s, controlSample))
  const clears = evidence.filter((e) => e.lower > policy.margin)
  const qualifying = clears.filter((e) => costOk(e, policy.costTolerance))
  const previous = stats.adoption?.to === control && stats.adoption.from !== control ? stats.adoption.from : undefined
  const back = qualifying.find((e) => e.arm === previous)
  if (back !== undefined) return { decision: "rollback", control, arm: back.arm, evidence: back, unscored }
  const pick = best(qualifying)
  if (pick !== undefined) return { decision: "recommend", control, arm: pick.arm, evidence: pick, unscored }
  const costly = best(clears)
  if (costly !== undefined) return { decision: "keep", reason: "cost", control, n: Math.min(controlN, costly.n), minN: policy.minN, margin: policy.margin, evidence: costly, unscored }
  const closest = best(evidence) as Evidence
  return { decision: "keep", reason: "interval", control, n: Math.min(controlN, closest.n), minN: policy.minN, margin: policy.margin, evidence: closest, unscored }
}

const vendorOfLabel = (label: string): string | undefined => {
  const parsed = parseCandidate(label)
  return parsed?.kind === "model" ? vendorOf(parsed.ref) : undefined
}

const failedOrInterrupted = (outcome: unknown) => outcome === "interrupted" || (typeof outcome === "string" && outcome.startsWith("failed:"))

/**
 * The reward of one explored run, or undefined when it has no reward signal. A failure, an
 * interruption or a failing last test run is 0. Tests that passed without the run editing a test
 * file are 1. Otherwise the first reviewer after the run from another vendor decides:
 * REQUEST-CHANGES is 0, APPROVE is 1, and a reviewer that succeeded without asking for changes is 1.
 */
export function reward(run: Pick<OutcomeRecord, "outcome" | "tests" | "touchedTests">, reviewer?: Pick<OutcomeRecord, "outcome" | "verdict">): 0 | 1 | undefined {
  if (failedOrInterrupted(run.outcome) || run.tests === "fail") return 0
  if (run.tests === "pass" && run.touchedTests !== true) return 1
  if (reviewer === undefined) return undefined
  if (reviewer.verdict === "request-changes") return 0
  if (reviewer.verdict === "approve") return 1
  return reviewer.outcome === "succeeded" ? 1 : undefined
}

export type StatsOptions = {
  now: number
  days?: number
  /** Tiers whose spawns are reviewers (`distinctVendor`); agents named like reviewers count too. */
  reviewerTiers?: ReadonlySet<string>
  adoptions?: readonly Adoption[]
}

const ended = (r: OutcomeRecord) => r.outcome !== undefined
const endOf = (r: OutcomeRecord) => r.at + (Number.isFinite(r.ms) ? r.ms : 0)
/** A usage value, unknown when absent or (on a legacy record) 0. */
const knownCost = (r: OutcomeRecord): number | undefined => {
  const c = r.cost
  return typeof c !== "number" || !Number.isFinite(c) || (r.v === undefined && c === 0) ? undefined : c
}

/**
 * Per tier and agent, the weighted sums of each arm's explored runs that ended inside the window
 * and stayed on their arm (a failover, a reroute or a hold-timeout end leaves a run out). A
 * reviewer run is matched to the latest run of the same parent session that ended before the
 * reviewer started. A reviewer that ended at the hold timeout (it may not have finished), or that
 * a failover or reroute moved off its model, gives no reward. Groups sort by tier, then agent.
 */
export function assessmentStats(records: Iterable<OutcomeRecord>, options: StatsOptions): GroupStats[] {
  const window = options.days !== undefined && Number.isFinite(options.days) && options.days > 0 ? options.days : REPORT_DEFAULT_DAYS
  const since = options.now - window * DAY_MS
  const all = [...records].filter((r) => ended(r) && r.at >= since)
  const isReviewer = (r: OutcomeRecord) => isReviewerAgent(r.agent) || (r.tier !== undefined && options.reviewerTiers?.has(r.tier) === true)
  const work = all.filter((r) => !isReviewer(r))
  const reviewsOf = new Map<OutcomeRecord, OutcomeRecord[]>()
  const settled = (r: OutcomeRecord) => r.heldExpired !== true && r.failedOver !== true && r.leftArm !== true
  for (const review of all.filter((r) => isReviewer(r) && settled(r)).sort((a, b) => a.at - b.at)) {
    let target: OutcomeRecord | undefined
    for (const r of work) if (r.parentID === review.parentID && endOf(r) <= review.at && (target === undefined || endOf(r) > endOf(target))) target = r
    if (target !== undefined) reviewsOf.set(target, [...(reviewsOf.get(target) ?? []), review])
  }
  type Group = { tier: string; agent: string; newest: OutcomeRecord; arms: Map<string, ArmSample>; unscored: number }
  const groups = new Map<string, Group>()
  for (const r of work) {
    const p = r.p
    if (r.policy === undefined || r.arm === undefined || !Array.isArray(r.eligible) || r.eligible.length === 0 || typeof p !== "number" || !(p > 0 && p <= 1)) continue
    if (r.failedOver === true || r.leftArm === true || r.heldExpired === true) continue
    const tier = r.tier ?? NO_TIER
    const key = JSON.stringify([tier, r.agent])
    const group = groups.get(key) ?? { tier, agent: r.agent, newest: r, arms: new Map(), unscored: 0 }
    groups.set(key, group)
    if (r.at > group.newest.at) group.newest = r
    const vendor = vendorOfLabel(r.arm)
    const reviewer = (reviewsOf.get(r) ?? []).find((v) => {
      const other = vendorOfLabel(v.model)
      return vendor !== undefined && other !== undefined && other !== vendor
    })
    const value = reward(r, reviewer)
    if (value === undefined) {
      group.unscored++
      continue
    }
    const w = 1 / p
    const s = group.arms.get(r.arm) ?? { arm: r.arm, n: 0, sumW: 0, sumW2: 0, sumWR: 0, costRuns: 0, sumWCost: 0, sumWRCost: 0 }
    s.n++
    s.sumW += w
    s.sumW2 += w * w
    s.sumWR += w * value
    const cost = knownCost(r)
    if (cost !== undefined) {
      s.costRuns++
      s.sumWCost += w * cost
      s.sumWRCost += w * value
    }
    group.arms.set(r.arm, s)
  }
  const latest = new Map<string, Adoption>()
  for (const a of options.adoptions ?? []) if ((latest.get(a.tier)?.at ?? Number.NEGATIVE_INFINITY) < a.at) latest.set(a.tier, a)
  return [...groups.values()]
    .map((g) => {
      const adoption = latest.get(g.tier)
      return {
        tier: g.tier,
        agent: g.agent,
        control: (g.newest.eligible as string[])[0] as string,
        arms: [...g.arms.values()],
        unscored: g.unscored,
        ...(adoption === undefined ? {} : { adoption }),
      }
    })
    .sort((a, b) => (a.tier === b.tier ? (a.agent < b.agent ? -1 : 1) : a.tier < b.tier ? -1 : 1))
}

/** Adoptions read back from storage; malformed entries are dropped. */
export function readAdoptions(value: unknown): Adoption[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (a): a is Adoption =>
      typeof a === "object" &&
      a !== null &&
      typeof a.tier === "string" &&
      typeof a.from === "string" &&
      typeof a.to === "string" &&
      typeof a.at === "number" &&
      (a.agent === undefined || typeof a.agent === "string"),
  )
}

/** The adoptions with one more, newest last, at most `MAX_ADOPTIONS`. */
export const addAdoption = (list: readonly Adoption[], adoption: Adoption): Adoption[] => [...list, adoption].slice(-MAX_ADOPTIONS)

const points = (v: number) => `${v < 0 ? "-" : "+"}${Math.abs(v * 100).toFixed(1)}`
const perSuccess = (v: number | undefined) => (v === Number.POSITIVE_INFINITY ? "no successes" : money(v))
const costText = (e: Evidence) => `cost/success ${perSuccess(e.armCostPerSuccess)} vs ${perSuccess(e.controlCostPerSuccess)}`
const gain = (e: Evidence) => `${points(e.diff)} pts (95% LB ${points(e.lower)})`

/** One line: `keep (n=12/30)` or `recommend <arm>: +8.1 pts (95% LB +5.3), cost/success $0.120 vs $0.140`. */
export function assessmentText(a: Assessment): string {
  const unscored = a.unscored > 0 ? `; ${a.unscored} run${a.unscored === 1 ? "" : "s"} without a reward signal` : ""
  if (a.decision !== "keep") {
    if (a.decision === "recommend") return `recommend ${a.arm}: ${gain(a.evidence)}, ${costText(a.evidence)}${unscored}`
    return `rollback to ${a.arm}: ${gain(a.evidence)} over the adopted ${a.control}, ${costText(a.evidence)}${unscored}`
  }
  const e = a.evidence
  if (a.reason === "runs" || e === undefined) return `keep (n=${a.n}/${a.minN})${unscored}`
  if (a.reason === "cost") return `keep: ${e.arm} ${gain(e)}, but ${costText(e)}${unscored}`
  return `keep: ${e.arm} ${gain(e)}, LB not above the ${(a.margin * 100).toFixed(1)}-pt margin${unscored}`
}

/**
 * One tier and agent's assessment as the check and the `usage` RPC carry it. `live` is the
 * control the tier resolves to now, absent when the tier no longer exists; when it is not the
 * assessed control, the recommendation no longer applies.
 */
export type AgentAssessment = { tier: string; agent: string; assessment: Assessment; text: string; live?: string; removed?: true }

/** A recommendation or rollback for a control the tier no longer resolves to. */
export const stale = (a: AgentAssessment): boolean => a.assessment.decision !== "keep" && a.live !== a.assessment.control
/** Why a stale recommendation no longer applies. */
export const staleText = (a: AgentAssessment) =>
  a.removed === true
    ? "tier no longer exists; the recommendation no longer applies"
    : a.live === undefined
      ? "tier resolves to no available model now; the recommendation does not apply"
      : "tier changed since this assessment; the recommendation no longer applies"

/** The "Assessment" section of `model_roles_check`; nothing when no tier has explored runs. */
export function formatAssessments(list: readonly AgentAssessment[]): string[] {
  if (list.length === 0) return []
  return ["Assessment (advisory; adopt through /tiers, nothing changes config by itself):", ...list.map((a) => `  ${a.tier}/${a.agent} assessment: ${a.text}${stale(a) ? ` (${staleText(a)})` : ""}`)]
}

/** The `assessments` of a `usage` reply; malformed entries are dropped. */
export function readAssessments(value: unknown): AgentAssessment[] {
  const list = typeof value === "object" && value !== null ? (value as { assessments?: unknown }).assessments : undefined
  if (!Array.isArray(list)) return []
  return list.filter(
    (a): a is AgentAssessment =>
      typeof a === "object" && a !== null && typeof a.tier === "string" && typeof a.agent === "string" && typeof a.text === "string" && typeof a.assessment?.decision === "string",
  )
}

/** The `adopt` field of a `set` call: which recommendation the new tier config adopts. */
export function readAdoptRequest(value: unknown): Omit<Adoption, "tier" | "at"> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { agent, from, to } = value as Record<string, unknown>
  if (typeof from !== "string" || typeof to !== "string" || from === to) return undefined
  return { from, to, ...(typeof agent === "string" ? { agent } : {}) }
}

export const ADOPT_PREFIX = "\u0000adopt:"

export type AssessmentRow = { title: string; value: string; description: string; disabled?: true }

/**
 * The `/tiers` usage rows of a tier's assessments: a recommendation or rollback is an action, a
 * keep is read-only, and so is a recommendation for a control the tier no longer resolves to.
 */
export function assessmentRows(tier: string, list: readonly AgentAssessment[]): AssessmentRow[] {
  return list
    .filter((a) => a.tier === tier)
    .map((a) =>
      a.assessment.decision === "keep"
        ? { title: `assessment ${a.agent}`, value: `\u0000assess:${a.agent}`, description: a.text, disabled: true as const }
        : stale(a)
          ? { title: `assessment ${a.agent}`, value: `\u0000assess:${a.agent}`, description: `${staleText(a)}: ${a.text}`, disabled: true as const }
          : { title: `Adopt recommendation (${a.agent})`, value: `${ADOPT_PREFIX}${a.agent}`, description: a.text },
    )
}
