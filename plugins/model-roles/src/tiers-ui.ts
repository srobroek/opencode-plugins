/**
 * The `/tiers` dialog's state and edits: what the server reports, the choices each
 * step offers, and the tier config each answer produces. Pure, so the TUI entry stays
 * a thin layer over `ui.dialog`.
 */

import { type AvailableModel, type Options, parseCandidate, resolveRole } from "./resolve.ts"
import { BUILTIN_TIERS, TIER_ALIASES, type TierConfig } from "./tiers.ts"

/** Effort choices, `auto` first. */
export const EFFORT_CHOICES = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

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
  /** What resolves now, if anything. */
  resolved?: string
  /** The entry in `options.tiers`, as configured. */
  configured?: TierConfig
}

export type PickModel = { ref: string; variants: string[] }

export type TierState = {
  tiers: TierRow[]
  models: PickModel[]
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
  config?: string
  error?: string
}): TierState {
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
    const resolved = resolveRole(input.options.roles, input.available, name).model
    if (resolved !== undefined) row.resolved = `${resolved.providerID}/${resolved.id}${resolved.variant ? `#${resolved.variant}` : ""}`
    const configured = input.configured[name]
    if (configured !== undefined) row.configured = configured
    return row
  })
  const models = input.available
    .filter((m) => m.enabled !== false)
    .map((m) => ({ ref: `${m.providerID}/${m.id}`, variants: (m.variants ?? []).map((v) => v.id) }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
  const state: TierState = { tiers, models }
  if (input.config !== undefined) state.config = input.config
  if (input.error !== undefined) state.error = input.error
  return state
}

/** Read a `state` reply defensively. */
export function readState(value: unknown): TierState | undefined {
  if (!isRecord(value) || !Array.isArray(value.tiers) || !Array.isArray(value.models)) return undefined
  return value as TierState
}

/** Why `name` cannot be a new tier, or `undefined` when it can. */
export function tierNameError(name: string, existing: ReadonlyArray<string>): string | undefined {
  const text = name.trim()
  if (!/^[a-z][a-z0-9-]*$/.test(text)) return "Use lowercase letters, digits and dashes, starting with a letter."
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

/** The models still to offer when picking in order: everything not picked yet. */
export function remainingModels(models: ReadonlyArray<PickModel>, picked: ReadonlyArray<string>): PickModel[] {
  const taken = new Set(
    picked.map((entry) => {
      const candidate = parseCandidate(entry)
      return candidate?.kind === "model" ? `${candidate.ref.providerID}/${candidate.ref.id}` : entry
    }),
  )
  return models.filter((m) => !taken.has(m.ref))
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
