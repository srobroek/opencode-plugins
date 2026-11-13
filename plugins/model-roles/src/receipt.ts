/**
 * Spawn receipts for `srobroek.model-roles`: for each subagent spawn the plugin routes, the
 * tier asked for and where from, the model it got, the precedence rule that picked the
 * variant, and what it fell back past. Pure; the plugin keeps the last few in storage.
 */

import { nearestVariant } from "./catalog.ts"
import { type CandidateStatus, candidateStatus, describeCandidate } from "./check.ts"
import type { HealthState } from "./health.ts"
import { type AvailableModel, type ModelRef, modelText, type Options, parseCandidate } from "./resolve.ts"
import type { TierMeta } from "./tiers.ts"

/** Where a spawn's tier came from. */
export type SpawnSource = "tier-param" | "role-param" | "agent" | "auto"

/** The precedence rule that decided the model and its variant. */
export type SpawnRule =
  | "explicit-model"
  | "agent-pin"
  | "candidate-variant"
  | "tier-effort"
  | "base-tier-effort"
  | "builtin-effort"
  | "auto-effort"
  | "model-default"

export type Receipt = {
  at: number
  agent: string
  source: SpawnSource
  tier?: string
  /** The old role name the spawn passed, when it was one. */
  alias?: string
  /** `provider/model#variant` the spawn runs on, when the plugin knows it. */
  model?: string
  rule: SpawnRule
  /** Candidates skipped before the one that runs, each with its reason. */
  fallbacks: string[]
  warnings: string[]
}

export const RECEIPTS_KEY = "receipts"
export const RECEIPT_LIMIT = 50

export function pushReceipt(list: ReadonlyArray<Receipt>, receipt: Receipt, limit = RECEIPT_LIMIT): Receipt[] {
  return [receipt, ...list].slice(0, limit)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string")

/** Stored receipts, malformed entries dropped. */
export function readReceipts(value: unknown): Receipt[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (r): r is Receipt =>
      isRecord(r) &&
      typeof r.at === "number" &&
      typeof r.agent === "string" &&
      typeof r.source === "string" &&
      typeof r.rule === "string" &&
      isStrings(r.fallbacks) &&
      isStrings(r.warnings),
  )
}

export type ExplainInput = {
  tier: string
  model: ModelRef
  meta: TierMeta | undefined
  /** The tier's candidates as configured, before any effort applied. */
  explicit: ReadonlyArray<string>
  /** The tier's candidates in the order it resolved them. */
  order: ReadonlyArray<string>
  /** Every model the host lists, enabled or not. */
  models: ReadonlyArray<AvailableModel>
  roles: Options["roles"]
  health: HealthState
  now: number
}

const bare = (ref: Pick<ModelRef, "providerID" | "id">) => `${ref.providerID}/${ref.id}`

/** The rule that picked a tier-resolved model's variant, and what was dropped on the way. */
export function explainSpawn(input: ExplainInput): Pick<Receipt, "rule" | "fallbacks" | "warnings"> {
  const { model, meta } = input
  const listed = input.models.find((m) => m.providerID === model.providerID && m.id === model.id)
  const variants = listed?.variants ?? []
  const effort = meta?.effort === "auto" ? undefined : meta?.effort
  const warnings: string[] = []
  let rule: SpawnRule
  if (model.variant !== undefined) {
    const explicit = input.explicit.some((entry) => {
      const candidate = parseCandidate(entry)
      return candidate?.kind === "model" && bare(candidate.ref) === bare(model) && candidate.ref.variant === model.variant
    })
    if (explicit || effort === undefined) {
      rule = "candidate-variant"
      if (effort !== undefined && nearestVariant(variants, effort) !== model.variant)
        warnings.push(`${modelText(model)} sets its own variant, which wins over the tier effort ${effort}`)
    } else rule = meta?.effortFrom === "base" ? "base-tier-effort" : meta?.effortFrom === "builtin" ? "builtin-effort" : "tier-effort"
  } else {
    rule = "model-default"
    if (effort !== undefined)
      warnings.push(
        variants.length === 0
          ? `${modelText(model)} has no variants; it runs at the model default, not effort ${effort}`
          : `${modelText(model)} has no variant near effort ${effort}; it runs at the model default`,
      )
  }
  return { rule, fallbacks: fallbacksBefore(input), warnings }
}

/** Candidates ahead of the winner that were not usable, with the check's reason. */
function fallbacksBefore(input: ExplainInput): string[] {
  const out: string[] = []
  for (const entry of input.order) {
    const candidate = parseCandidate(entry)
    if (candidate?.kind !== "model") continue
    const { ref } = candidate
    if (bare(ref) === bare(input.model) && (ref.variant === undefined || ref.variant === input.model.variant)) break
    const status: CandidateStatus = candidateStatus(entry, input.models, input.roles, input.health, input.now)
    if (status.status !== "available") out.push(`${entry}: ${describeCandidate(status)}`)
  }
  return out
}

const SOURCE_TEXT: Record<SpawnSource, string> = {
  "tier-param": "tier param",
  "role-param": "role param",
  agent: "agent tier",
  auto: "auto routing",
}

const RULE_TEXT: Record<SpawnRule, string> = {
  "explicit-model": "explicit model",
  "agent-pin": "the agent's own model",
  "candidate-variant": "candidate variant",
  "tier-effort": "tier effort",
  "base-tier-effort": "base tier effort",
  "builtin-effort": "built-in effort",
  "auto-effort": "auto effort",
  "model-default": "model default",
}

/** The receipts for `model_roles_check`, newest first, one line each. */
export function formatReceipts(list: ReadonlyArray<Receipt>): string[] {
  if (list.length === 0) return []
  const lines = ["", "Recent spawns (newest first):"]
  for (const r of list) {
    const time = new Date(r.at).toISOString().slice(11, 19)
    const source = SOURCE_TEXT[r.source as SpawnSource] ?? r.source
    const asked = r.tier === undefined ? source : `tier ${r.tier} (${r.alias === undefined ? "" : `${r.alias}, `}${source})`
    const parts = [`${time} ${r.agent}: ${asked} → ${r.model ?? "the agent's model"} by ${RULE_TEXT[r.rule as SpawnRule] ?? r.rule}`]
    if (r.fallbacks.length > 0) parts.push(`fell back past ${r.fallbacks.join(", ")}`)
    for (const warning of r.warnings) parts.push(`warning: ${warning}`)
    lines.push(`  - ${parts.join("; ")}`)
  }
  return lines
}
