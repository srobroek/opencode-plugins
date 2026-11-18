/**
 * Announcements of new recommendations. After scored outcomes the server re-assesses the explored
 * agents; a recommendation or rollback it has not announced yet becomes a stored finding, which
 * the TUI shows as a toast once and as a badge until the user has seen it. All pure: the server
 * and the TUI only wire these functions to storage, RPC and the clock.
 */

import { type AgentAssessment, type Evidence, stale } from "./assess.ts"
import { money } from "./report.ts"

export const FINDINGS_KEY = "findings"
export const MAX_FINDINGS = 50
/** The least time between two re-assessments. */
export const ASSESS_INTERVAL_MS = 60_000

/**
 * One announced assessment. `arm` is the recommended arm, or for a rollback the arm to go back to;
 * `control` is the arm the tier uses now. The numbers are kept as the text shown, since the
 * evidence holds values (Infinity) that JSON storage cannot carry.
 */
export type Finding = {
  tier: string
  agent: string
  verdict: "recommend" | "rollback"
  arm: string
  control: string
  /** Signed percentage points, for example `+8.1`. */
  pts: string
  /** Signed lower bound of the 95% interval in points. */
  lb: string
  cost: string
  cost0: string
  at: number
  /** True once the user opened or dismissed it. */
  seen: boolean
}

const points = (v: number) => `${v < 0 ? "-" : "+"}${Math.abs(v * 100).toFixed(1)}`
const perSuccess = (v: number | undefined) => (v === Number.POSITIVE_INFINITY ? "no successes" : money(v))

/** Who a finding is about: one entry per tier and agent. */
export const findingKey = (f: Pick<Finding, "tier" | "agent">) => `${f.tier}\u0000${f.agent}`
/** What a toast is about: a changed verdict or arm is a different announcement. */
export const toastKey = (f: Pick<Finding, "tier" | "agent" | "verdict" | "arm">) => `${findingKey(f)}\u0000${f.verdict}\u0000${f.arm}`

const evidenceFields = (e: Evidence) => ({ pts: points(e.diff), lb: points(e.lower), cost: perSuccess(e.armCostPerSuccess), cost0: perSuccess(e.controlCostPerSuccess) })

/** The finding an assessment makes, or undefined for a keep. */
export function findingOf(a: AgentAssessment, at: number): Finding | undefined {
  const d = a.assessment
  // A recommendation whose tier changed since it was assessed no longer applies: it is not announced.
  if (d.decision === "keep" || stale(a)) return undefined
  return { tier: a.tier, agent: a.agent, verdict: d.decision, arm: d.arm, control: d.control, ...evidenceFields(d.evidence), at, seen: false }
}

const isFinding = (f: unknown): f is Finding => {
  if (typeof f !== "object" || f === null) return false
  const r = f as Record<string, unknown>
  return (
    typeof r.tier === "string" &&
    typeof r.agent === "string" &&
    (r.verdict === "recommend" || r.verdict === "rollback") &&
    ["arm", "control", "pts", "lb", "cost", "cost0"].every((k) => typeof r[k] === "string") &&
    typeof r.at === "number" &&
    typeof r.seen === "boolean"
  )
}

/** Stored or RPC findings; malformed entries are dropped. */
export const readFindings = (value: unknown): Finding[] => (Array.isArray(value) ? value.filter(isFinding) : [])

/**
 * The findings after one assessment pass, newest last and at most `MAX_FINDINGS`. A finding is
 * new when its tier and agent have no entry, or the entry's verdict or arm differs; it starts
 * unseen. An unchanged finding keeps its entry (and its seen flag) as it was. A keep clears the
 * entry. Entries of agents the pass did not assess stay.
 */
export function announceFindings(stored: readonly Finding[], assessments: readonly AgentAssessment[], at: number): Finding[] {
  let list = [...stored]
  for (const a of assessments) {
    const next = findingOf(a, at)
    const at0 = list.findIndex((f) => f.tier === a.tier && f.agent === a.agent)
    if (next === undefined) {
      if (at0 >= 0) list.splice(at0, 1)
      continue
    }
    const old = at0 >= 0 ? list[at0] : undefined
    if (old !== undefined && old.verdict === next.verdict && old.arm === next.arm) continue
    if (at0 >= 0) list.splice(at0, 1)
    list.push(next)
  }
  list = list.slice(-MAX_FINDINGS)
  return list
}

/** The findings with one tier and agent marked seen. */
export const markSeen = (list: readonly Finding[], tier: string, agent: string): Finding[] =>
  list.map((f) => (f.tier === tier && f.agent === agent && !f.seen ? { ...f, seen: true } : f))

export const unseen = (list: readonly Finding[]): Finding[] => list.filter((f) => !f.seen)

/** The findings that still hold: an assessment of the same verdict and arm that is not stale. A tier changed since the assessment drops its finding from the badge before the next pass clears it. */
export const current = (list: readonly Finding[], assessments: readonly AgentAssessment[]): Finding[] =>
  list.filter((f) => assessments.some((a) => a.tier === f.tier && a.agent === f.agent && !stale(a) && a.assessment.decision === f.verdict && "arm" in a.assessment && a.assessment.arm === f.arm))

/** The toast for a finding. */
export function toastText(f: Finding): string {
  if (f.verdict === "rollback") return `model-roles: ${f.agent}'s adopted ${f.control} now trails ${f.arm}. Review in /tiers.`
  return `model-roles: ${f.agent} could use ${f.arm} (${f.pts} pts, 95% LB ${f.lb}, cost/success ${f.cost} vs ${f.cost0}). Review in /tiers.`
}

/** The badge text, or undefined when nothing is unseen. */
export const badgeText = (count: number): string | undefined => (count > 0 ? `tiers: ${count} new` : undefined)

export type ThrottleOptions = {
  intervalMs: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Runs `run` after a trigger, at most once per `intervalMs`: triggers while a run is waiting
 * join it, and a trigger after a run waits out the rest of the interval (a trailing throttle).
 * A failing `run` is passed to `onError` and does not stop later runs.
 */
export function createThrottle(run: () => Promise<void>, options: ThrottleOptions, onError: (error: unknown) => void = () => {}) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let last: number | undefined
  let pending: unknown
  let waiting = false
  let disposed = false
  return {
    trigger() {
      if (waiting || disposed) return
      waiting = true
      const wait = last === undefined ? 0 : Math.max(0, last + options.intervalMs - now())
      pending = setTimer(() => {
        waiting = false
        last = now()
        void run().catch(onError)
      }, wait)
    },
    dispose() {
      disposed = true
      if (waiting) clearTimer(pending)
      waiting = false
    },
  }
}
