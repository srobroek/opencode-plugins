/**
 * Opt-in epsilon-exploration inside a tier. A few spawns of the agents listed in
 * `evaluate.agents` run on another effort or another candidate of their own tier, so the outcome
 * ledger collects evidence for the alternatives. The choice and its probability are logged;
 * nothing here changes a config or reads the ledger. All pure: the plugin passes the facts in.
 */

import { EFFORT_SCALE } from "./catalog.ts"
import type { ModelRef } from "./resolve.ts"
import { modelLabel } from "./spawn-role.ts"

/** Version of the exploration policy, stored with each eligible spawn. */
export const EXPLORE_POLICY = "explore-v1"
export const DEFAULT_EXPLORE = 0.05
export const MAX_EXPLORE = 0.1
export const DEFAULT_MAX_ARMS = 3
export const MAX_ARMS_LIMIT = 6

export type ExploreOptions = {
  /** Agents that may explore; empty turns exploration off. */
  agents: string[]
  /** Probability that an eligible spawn leaves the control. */
  explore: number
  /** Most alternatives to the control; keeps the probability per arm high enough to reach `minN`. */
  maxArms: number
  // Read by the assessment, not by exploration.
  minN: number
  margin: number
  costTolerance: number
}

export const DEFAULT_EXPLORE_OPTIONS: ExploreOptions = { agents: [], explore: DEFAULT_EXPLORE, maxArms: DEFAULT_MAX_ARMS, minN: 30, margin: 0.05, costTolerance: 0 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The exploration fields of the `evaluate` option, with defaults, and a warning per bad value. */
export function parseExplore(raw: unknown): { options: ExploreOptions; warnings: string[] } {
  const input = isRecord(raw) ? raw : {}
  const options = { ...DEFAULT_EXPLORE_OPTIONS }
  const warnings: string[] = []
  if (input.agents !== undefined) {
    if (Array.isArray(input.agents) && input.agents.every((a) => typeof a === "string"))
      options.agents = [...new Set((input.agents as string[]).map((a) => a.trim()).filter((a) => a !== ""))]
    else warnings.push("evaluate.agents must be an array of agent ids; exploration stays off")
  }
  const number = (key: "explore" | "maxArms" | "minN" | "margin" | "costTolerance", ok: (n: number) => boolean, need: string): number | undefined => {
    const value = input[key]
    if (value === undefined) return undefined
    if (typeof value === "number" && Number.isFinite(value) && ok(value)) return value
    warnings.push(`evaluate.${key} must be ${need}; using ${options[key]}`)
    return undefined
  }
  const explore = number("explore", (n) => n >= 0, "a number of at least 0")
  if (explore !== undefined) {
    options.explore = Math.min(MAX_EXPLORE, explore)
    if (explore > MAX_EXPLORE) warnings.push(`evaluate.explore ${explore} is above ${MAX_EXPLORE}; using ${MAX_EXPLORE}`)
  }
  const maxArms = number("maxArms", (n) => Number.isInteger(n) && n >= 1, "a whole number of at least 1")
  if (maxArms !== undefined) {
    options.maxArms = Math.min(MAX_ARMS_LIMIT, maxArms)
    if (maxArms > MAX_ARMS_LIMIT) warnings.push(`evaluate.maxArms ${maxArms} is above ${MAX_ARMS_LIMIT}; using ${MAX_ARMS_LIMIT}`)
  }
  options.minN = number("minN", (n) => Number.isInteger(n) && n >= 1, "a whole number of at least 1") ?? options.minN
  options.margin = number("margin", (n) => n >= 0 && n < 1, "a number from 0 up to 1") ?? options.margin
  options.costTolerance = number("costTolerance", (n) => n >= 0, "a number of at least 0") ?? options.costTolerance
  return { options, warnings }
}

/** Exploration runs only for a non-empty agent list and an `explore` above 0. */
export const exploring = (options: ExploreOptions): boolean => options.agents.length > 0 && options.explore > 0

/**
 * Agents whose verdicts are rewards: named `*-reviewer` or `adversarial-challenger`. A spawn on a
 * tier with `distinctVendor` (the reviewer tiers) counts as one too, see `eligible`.
 */
export const isReviewerAgent = (agent: string): boolean => /-reviewer$/.test(agent) || agent === "adversarial-challenger"

export type ExploreSpawn = {
  agent: string
  /** The caller passed `model`. */
  explicitModel: boolean
  /** The target agent has a model of its own (config or frontmatter). */
  pinned: boolean
  /** The spawn names an existing child. */
  resume: boolean
  /** The agent's or the tier's effort is `auto`: the decider picks it. */
  effortAuto: boolean
  /** The tier has `distinctVendor`. */
  distinctVendorTier: boolean
  /** Eligible arms, the control included. */
  armCount: number
}

/** Whether a spawn may explore. */
export function eligible(spawn: ExploreSpawn, options: Pick<ExploreOptions, "agents">): boolean {
  if (spawn.explicitModel || spawn.pinned || spawn.resume || spawn.effortAuto) return false
  if (!options.agents.includes(spawn.agent)) return false
  if (spawn.distinctVendorTier || isReviewerAgent(spawn.agent)) return false
  return spawn.armCount > 1
}

export type Arm = { label: string; model: ModelRef }

export type ArmFilters = {
  /** Variant ids the model supports. */
  variantsOf: (model: ModelRef) => readonly string[]
  /** False for a model the guard refuses or the tier's vendor rule excludes. */
  allowed: (model: ModelRef) => boolean
}

const armOf = (model: ModelRef): Arm => ({ label: modelLabel(model), model })
const sameBase = (a: ModelRef, b: ModelRef) => a.providerID === b.providerID && a.id === b.id

/** The variant one step up (`1`) or down (`-1`) the effort scale from the control's own, among those the model has. */
function neighbour(control: ModelRef, variants: readonly string[], step: 1 | -1): string | undefined {
  const scale: readonly string[] = EFFORT_SCALE
  const at = control.variant === undefined ? -1 : scale.indexOf(control.variant)
  if (at < 0) return undefined
  const ranked = variants.map((v) => ({ v, rank: scale.indexOf(v) })).filter((e) => e.rank >= 0)
  const next = step === 1 ? ranked.filter((e) => e.rank > at).sort((a, b) => a.rank - b.rank) : ranked.filter((e) => e.rank < at).sort((a, b) => b.rank - a.rank)
  return next[0]?.v
}

/**
 * The arms of a spawn: the control, then at most `maxArms` alternatives, in this order: the
 * control model one effort step up, one step down (on the effort scale, among the variants the
 * model has), the next tier candidate at its configured variant, then further candidates. A
 * control without a variant on the scale has no up or down. The cap applies first; the filters
 * (guard, vendor rule) then drop an alternative, and a dropped one is not replaced by a later
 * candidate. The control is never filtered.
 */
export function arms(tierCandidates: readonly ModelRef[], control: ModelRef, filters: ArmFilters, maxArms: number = DEFAULT_MAX_ARMS): Arm[] {
  const variants = filters.variantsOf(control)
  const picks: ModelRef[] = []
  for (const step of [1, -1] as const) {
    const variant = neighbour(control, variants, step)
    if (variant !== undefined) picks.push({ providerID: control.providerID, id: control.id, variant })
  }
  for (const candidate of tierCandidates) if (!sameBase(candidate, control)) picks.push(candidate)
  const out: Arm[] = [armOf(control)]
  const seen = new Set(out.map((a) => a.label))
  for (const model of picks.slice(0, Math.max(0, maxArms))) {
    const arm = armOf(model)
    if (seen.has(arm.label) || !filters.allowed(model)) continue
    seen.add(arm.label)
    out.push(arm)
  }
  return out
}

export type Chosen = { arm: Arm; p: number }

/**
 * The control with probability 1 - explore, else one of the other arms, uniformly. `p` is the
 * probability of the arm chosen. `rand` returns a number in [0, 1); one draw decides both.
 */
export function chooseArm(all: readonly Arm[], explore: number, rand: () => number): Chosen {
  const [control, ...others] = all
  if (control === undefined) throw new Error("chooseArm needs the control arm")
  if (others.length === 0 || explore <= 0) return { arm: control, p: 1 }
  const draw = rand()
  if (draw >= explore) return { arm: control, p: 1 - explore }
  const index = Math.min(others.length - 1, Math.floor((draw / explore) * others.length))
  return { arm: others[index] as Arm, p: explore / others.length }
}

/** What the ledger and the snapshot keep of an eligible spawn. */
export type ExploreFacts = { policy: string; eligible: string[]; arm: string; p: number }

export const exploreFacts = (all: readonly Arm[], chosen: Chosen): ExploreFacts => ({
  policy: EXPLORE_POLICY,
  eligible: all.map((a) => a.label),
  arm: chosen.arm.label,
  p: chosen.p,
})
