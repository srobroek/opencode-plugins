/**
 * The `/tiers` dialog's state and edits: what the server reports, the choices each
 * step offers, and the tier config each answer produces. Pure, so the TUI entry stays
 * a thin layer over `ui.dialog`.
 */

import type { CandidateStatus } from "./check.ts"
import {
  type AgentLike,
  type AgentTierSource,
  type AvailableModel,
  agentTier,
  type HealthView,
  modelText,
  type Options,
  parseCandidate,
  resolveRole,
  userPin,
} from "./resolve.ts"
import { BUILTIN_TIERS, parseTierConfig, TIER_ALIASES, type TierConfig } from "./tiers.ts"

/** Effort choices, `auto` first. */
export const EFFORT_CHOICES = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type CandidateHealth = { entry: string } & CandidateStatus

export type TierRow = {
  name: string
  builtin: boolean
  source: string
  effort?: string
  purpose: string
  purposeMissing?: boolean
  distinctVendor: boolean
  cost: string
  /** Current candidates, in order. */
  candidates: string[]
  /** Each candidate's status now: available, unhealthy, unknown id or variant, provider unavailable. */
  health?: CandidateHealth[]
  /** What resolves now, if anything. */
  resolved?: string
  /** The entry in `options.tiers`, as configured. */
  configured?: TierConfig
}

/**
 * An agent the host reports: its tier and where that comes from (both absent when it has none and
 * runs the session model), what the tier resolves to, its own model (`pinned`, which wins), and its description.
 */
export type AgentRow = {
  id: string
  tier?: string
  source?: AgentTierSource
  resolved?: string
  pinned?: string
  description?: string
}

export type PickModel = { ref: string; variants: string[] }

export type TierState = {
  tiers: TierRow[]
  models: PickModel[]
  agents: AgentRow[]
  /** The config file `set` writes, or why there is none. */
  config?: string
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The server's view for the dialog. */
export function tierState(input: {
  options: Options
  available: ReadonlyArray<AvailableModel>
  configured: Readonly<Record<string, TierConfig>>
  agents?: ReadonlyArray<AgentLike>
  health?: HealthView
  /** A candidate's status, for the per-candidate health. */
  status?: (entry: string) => CandidateStatus
  config?: string
  error?: string
}): TierState {
  const resolve = (name: string) => {
    const model = resolveRole(input.options.roles, input.available, name, input.health).model
    return model === undefined ? undefined : modelText(model)
  }
  const tiers: TierRow[] = Object.entries(input.options.tiers ?? {}).map(([name, meta]) => {
    const row: TierRow = {
      name,
      builtin: (BUILTIN_TIERS as readonly string[]).includes(name),
      source: meta.source,
      purpose: meta.purpose,
      distinctVendor: meta.distinctVendor,
      cost: meta.cost,
      candidates: [...(input.options.roles[name] ?? [])],
    }
    if (meta.effort !== undefined) row.effort = meta.effort
    if (meta.purposeMissing) row.purposeMissing = true
    const status = input.status
    if (status !== undefined) row.health = row.candidates.map((entry) => ({ entry, ...status(entry) }))
    const resolved = resolve(name)
    if (resolved !== undefined) row.resolved = resolved
    const configured = input.configured[name]
    if (configured !== undefined) row.configured = configured
    return row
  })
  const agents: AgentRow[] = []
  for (const agent of [...(input.agents ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const found = agentTier(agent, input.options.agents, input.options.implicit)
    const row: AgentRow = { id: agent.id }
    if (found !== undefined) {
      row.tier = found.tier
      row.source = found.source
      const resolved = resolve(found.tier)
      if (resolved !== undefined) row.resolved = resolved
    }
    if (agent.description !== undefined && agent.description.trim() !== "") row.description = agent.description.trim()
    const pin = userPin(agent)
    if (pin !== undefined) row.pinned = modelText(pin)
    agents.push(row)
  }
  const models = input.available
    .filter((m) => m.enabled !== false)
    .map((m) => ({ ref: `${m.providerID}/${m.id}`, variants: (m.variants ?? []).map((v) => v.id) }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
  const state: TierState = { tiers, models, agents }
  if (input.config !== undefined) state.config = input.config
  if (input.error !== undefined) state.error = input.error
  return state
}

/** Read a `state` reply defensively; a reply without `agents` lists none. */
export function readState(value: unknown): TierState | undefined {
  if (!isRecord(value) || !Array.isArray(value.tiers) || !Array.isArray(value.models)) return undefined
  return { ...(value as TierState), agents: Array.isArray(value.agents) ? (value.agents as AgentRow[]) : [] }
}

/** Why `tier` cannot be an agent's tier, or `undefined` when it can. */
export function agentTierError(tier: unknown, tiers: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof tier !== "string" || !Object.hasOwn(tiers, tier)) return `Unknown tier ${JSON.stringify(tier)}.`
  return undefined
}

/**
 * The agent assignments after the global file's `agents` changed. The host gives the plugin one merged
 * `options`, so a project entry cannot be told from the global one directly; instead an assignment in
 * `given` (the options at startup) that the global file did not hold at startup (`startup`) with the same
 * value is the project's. Those stay and win; the global file's current map (`current`) fills the rest.
 */
export function mergeAgents(
  given: Readonly<Record<string, string>>,
  startup: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Record<string, string> {
  const project: Record<string, string> = {}
  for (const [agent, tier] of Object.entries(given)) {
    if (!(Object.hasOwn(startup, agent) && startup[agent] === tier)) project[agent] = tier
  }
  return { ...current, ...project }
}

/** Tier names `set` and drafts accept. */
export const TIER_NAME = /^[a-z][a-z0-9-]*$/

/** The `draft` of a `state` call: tier configs to preview, `null` for a tier removed. Bad names are dropped. */
export function readDraft(input: unknown): Record<string, TierConfig | null> {
  const draft = isRecord(input) && isRecord(input.draft) ? input.draft : {}
  const out: Record<string, TierConfig | null> = {}
  for (const [name, value] of Object.entries(draft)) {
    if (!TIER_NAME.test(name)) continue
    out[name] = value === null ? null : parseTierConfig(value)
  }
  return out
}

/** The configured tiers with a draft laid over them. */
export function applyDraft(
  configured: Readonly<Record<string, TierConfig>>,
  draft: Readonly<Record<string, TierConfig | null>>,
): Record<string, TierConfig> {
  const out: Record<string, TierConfig> = { ...configured }
  for (const [name, value] of Object.entries(draft)) {
    if (value === null) delete out[name]
    else out[name] = value
  }
  return out
}

/**
 * Check a tier config before `set` writes it. `listed` is what the host lists now (enabled or
 * not), `catalog` every model the provider definitions know. An unknown model or a variant the
 * model lacks is an error; a known model that is not available now is a warning.
 */
export function validateTierConfig(
  config: TierConfig | undefined,
  listed: ReadonlyArray<AvailableModel>,
  catalog: ReadonlyArray<AvailableModel>,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  for (const entry of Array.isArray(config?.model) ? config.model : []) {
    const candidate = parseCandidate(entry)
    if (candidate === undefined) {
      errors.push(`${JSON.stringify(entry)} is not provider/model, provider/model#variant or @tier.`)
      continue
    }
    if (candidate.kind === "role") continue
    const { ref } = candidate
    const same = (m: AvailableModel) => m.providerID === ref.providerID && m.id === ref.id
    const model = listed.find(same) ?? catalog.find(same)
    const name = `${ref.providerID}/${ref.id}`
    if (model === undefined) {
      errors.push(`Unknown model ${name}: no provider lists it.`)
      continue
    }
    const variants = (model.variants ?? []).map((v) => v.id)
    if (ref.variant !== undefined && !variants.includes(ref.variant)) {
      errors.push(`${name} has no variant ${ref.variant} (it has: ${variants.join(", ") || "none"}).`)
      continue
    }
    if (!listed.some((m) => same(m) && m.enabled !== false))
      warnings.push(`${name} is not available now (provider not connected, or disabled); the tier skips it until it is.`)
  }
  return { errors, warnings }
}

/** Why `name` cannot be a new tier, or `undefined` when it can. */
export function tierNameError(name: string, existing: ReadonlyArray<string>): string | undefined {
  const text = name.trim()
  if (!TIER_NAME.test(text)) return "Use lowercase letters, digits and dashes, starting with a letter."
  if (existing.includes(text)) return `Tier ${text} already exists.`
  if (Object.hasOwn(TIER_ALIASES, text) || text === "default") return `${text} is an old role name for a built-in tier.`
  return undefined
}

/** One line describing a tier for the picker. */
export function tierSummary(row: TierRow): string {
  const model = row.configured?.model
  const how = Array.isArray(model) ? `${model.length} model${model.length === 1 ? "" : "s"}` : row.source === "roles" ? "from roles" : "auto"
  const effort = row.effort === undefined ? "" : `, effort ${row.effort}`
  return `${how}${effort} → ${row.resolved ?? "nothing available"}`
}

/** The configured model list as bare refs plus their explicit efforts. */
export function configuredModels(row: TierRow): string[] {
  const model = row.configured?.model
  return Array.isArray(model) ? [...model] : []
}

/** `config` without empty fields; `undefined` when nothing is left (the tier is fully auto). */
export function compact(config: TierConfig): TierConfig | undefined {
  const next: TierConfig = {}
  if (config.model !== undefined) next.model = config.model
  if (config.effort !== undefined) next.effort = config.effort
  if (config.purpose !== undefined && config.purpose.trim() !== "") next.purpose = config.purpose.trim()
  if (config.distinctVendor !== undefined) next.distinctVendor = config.distinctVendor
  return Object.keys(next).length === 0 ? undefined : next
}

export type TierEdit =
  | { kind: "models"; models: string[] | "auto" }
  | { kind: "effort"; effort: string | undefined }
  | { kind: "purpose"; purpose: string }
  | { kind: "reset" }

/**
 * The tier config after one edit. A model list of none means auto. Reset drops
 * everything for a built-in tier, and keeps only the purpose of a custom one.
 */
export function applyEdit(row: Pick<TierRow, "builtin" | "configured" | "purpose" | "purposeMissing">, edit: TierEdit): TierConfig | undefined {
  const current: TierConfig = { ...(row.configured ?? {}) }
  switch (edit.kind) {
    case "models":
      if (edit.models === "auto" || edit.models.length === 0) current.model = "auto"
      else current.model = [...edit.models]
      break
    case "effort":
      if (edit.effort === undefined) delete current.effort
      else current.effort = edit.effort
      break
    case "purpose":
      current.purpose = edit.purpose
      break
    case "reset": {
      if (row.builtin) return undefined
      const purpose = current.purpose ?? (row.purposeMissing ? undefined : row.purpose)
      return compact({ model: "auto", ...(purpose === undefined ? {} : { purpose }) })
    }
  }
  // A built-in tier that is back to plain auto needs no entry.
  if (row.builtin && current.model === "auto" && current.effort === undefined && current.purpose === undefined && current.distinctVendor === undefined)
    return undefined
  return compact(current)
}
