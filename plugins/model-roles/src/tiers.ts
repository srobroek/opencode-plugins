/**
 * Tier configuration for `srobroek.model-roles`: the `tiers` option, the built-in
 * tiers and their purposes, the legacy role aliases, and the resolution map the rest
 * of the plugin resolves against. Pure: the plugin rebuilds it whenever model
 * availability or the reference prices change.
 */

import {
  type Billing,
  basePrice,
  billingOf,
  type CatalogModel,
  candidateFor,
  canonical,
  DEFAULT_PREMIUM,
  DEFAULT_TIER_EFFORT,
  type Derived,
  type DeriveOptions,
  deriveTiers,
  lineupRank,
  nearestVariant,
  type ReferenceIndex,
  vendorOf,
} from "./catalog.ts"
import {
  type AvailableModel,
  type HealthView,
  type ModelRef,
  type Options,
  parseCandidate,
  type Resolution,
  resolveRole,
} from "./resolve.ts"

export const BUILTIN_TIERS = ["cheap", "standard", "strong", "reviewer"] as const

/** When the parent should pick each built-in tier. */
export const TIER_PURPOSE: Readonly<Record<string, string>> = {
  cheap: "cheap and fast: lookups, summaries, log and diff reading, mechanical edits",
  standard: "everyday implementation and investigation",
  strong: "hard reasoning: design, root-cause debugging, subtle concurrency or data-integrity work",
  reviewer: "an independent second opinion or review, from another model vendor than yours when one is available",
}

/** Old role names and the tier (and effort) they stand for. */
export const TIER_ALIASES: Readonly<Record<string, { tier: string; effort?: string }>> = {
  smol: { tier: "cheap" },
  commit: { tier: "cheap" },
  tiny: { tier: "cheap", effort: "none" },
  task: { tier: "standard" },
  slow: { tier: "strong" },
  plan: { tier: "strong" },
  architect: { tier: "strong" },
  designer: { tier: "strong" },
  challenger: { tier: "reviewer" },
  judge: { tier: "reviewer" },
}

/** Names that mean "no tier: inherit the session model". */
export const INHERIT_NAMES: ReadonlyArray<string> = ["default"]

/**
 * Legacy `roles` entries that seed a tier with no model of its own, after a role of the
 * tier's own name; the first one present wins.
 */
export const TIER_SEEDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  cheap: ["smol", "commit"],
  standard: ["task"],
  strong: ["slow", "plan", "architect", "designer"],
  reviewer: ["challenger", "judge"],
}

const seedsOf = (name: string): string[] => [name, ...(TIER_SEEDS[name] ?? [])]

/** Built-in agents and the tier they get unless the config or a header says otherwise. */
export const BUILTIN_AGENT_TIERS: Readonly<Record<string, string>> = {
  explore: "cheap",
  title: "tiny",
  summary: "tiny",
  compaction: "cheap",
}

/** `general` gets this tier only while the per-spawn auto picker is off. */
export const GENERAL_TIER = "standard"

export type TierConfig = {
  /** `"auto"`, or candidates in fallback order (`provider/model#effort` or `@tier`). Absent: a legacy role, else auto. */
  model?: "auto" | string[]
  /** A level from the effort scale, or `"auto"` for the decider to pick per spawn. */
  effort?: string
  purpose?: string
  distinctVendor?: boolean
}

export type TierSettings = {
  tiers: Record<string, TierConfig>
  /** The deprecated `roles` option, verbatim. */
  legacy: Record<string, string[]>
  /** The deprecated `purposes` option. */
  purposes: Record<string, string>
  derive: DeriveOptions
}

/** Where a tier's candidates come from. */
export type TierSource = "config" | "roles" | "derived" | "strong" | "standard"

export type TierMeta = {
  purpose: string
  /** A custom tier with no purpose of its own. */
  purposeMissing?: true
  effort?: string
  distinctVendor: boolean
  source: TierSource
  /** Cost class of the first available candidate, for the spawner. */
  cost: string
}

/** How expensive a listed model is: its lineup rank (0 cheap, 1 standard, 2 strong) and premium flag. */
export type ModelClass = { billing: Billing; price?: number; rank?: number; premium: boolean }

export type TierSet = {
  /** Resolution map: tiers, aliases and legacy role names. */
  roles: Record<string, string[]>
  /** Tiers the spawner may pick, in display order. */
  tiers: Record<string, TierMeta>
  /** Classes by `provider/model`. */
  classes: Record<string, ModelClass>
  derived: Derived
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] =>
  (typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim())

/** Normalise one `tiers.<name>` entry. A bare string or list is the model. */
export function parseTierConfig(raw: unknown): TierConfig {
  const input = isRecord(raw) ? raw : { model: raw }
  const config: TierConfig = {}
  if (input.model === "auto") config.model = "auto"
  else if (input.model !== undefined) {
    const listed = strings(input.model)
    config.model = listed.length === 0 ? "auto" : listed
  }
  if (typeof input.effort === "string" && input.effort.trim() !== "") config.effort = input.effort.trim()
  if (typeof input.purpose === "string" && input.purpose.trim() !== "") config.purpose = input.purpose.trim()
  if (typeof input.distinctVendor === "boolean") config.distinctVendor = input.distinctVendor
  return config
}

/** Read `tiers`, the deprecated `roles` and `purposes`, and the derivation options. */
export function parseTierSettings(raw: unknown): TierSettings {
  const input = isRecord(raw) ? raw : {}
  const tiers: Record<string, TierConfig> = {}
  if (isRecord(input.tiers)) {
    for (const [name, value] of Object.entries(input.tiers)) {
      const key = name.trim()
      if (key === "" || INHERIT_NAMES.includes(key)) continue
      tiers[key] = parseTierConfig(value)
    }
  }
  const legacy: Record<string, string[]> = {}
  if (isRecord(input.roles)) for (const [role, value] of Object.entries(input.roles)) legacy[role] = strings(value)
  const purposes: Record<string, string> = {}
  if (isRecord(input.purposes)) {
    for (const [role, text] of Object.entries(input.purposes)) if (typeof text === "string" && text.trim() !== "") purposes[role] = text.trim()
  }
  const derive: DeriveOptions = {}
  if (input.prefer !== undefined) derive.prefer = strings(input.prefer)
  if (input.avoid !== undefined) derive.avoid = strings(input.avoid)
  if (input.include !== undefined) derive.include = strings(input.include)
  if (typeof input.premium === "number" && Number.isFinite(input.premium) && input.premium > 0) derive.premium = input.premium
  return { tiers, legacy, purposes, derive }
}

/** The tier an alias (or a tier name) stands for. */
export const tierOf = (name: string): string => TIER_ALIASES[name]?.tier ?? name

const findModel = (models: ReadonlyArray<CatalogModel>, ref: ModelRef): CatalogModel | undefined =>
  models.find((m) => m.providerID === ref.providerID && m.id === ref.id)

/**
 * `list` with every model entry set to `effort`'s nearest variant. `"auto"` drops the
 * variant (the model default, or the decider's pick per spawn). `@links` and entries
 * for models this machine does not list stay as they are.
 */
export function withEffort(list: ReadonlyArray<string>, effort: string | undefined, models: ReadonlyArray<CatalogModel>, keepExplicit = false): string[] {
  if (effort === undefined) return [...list]
  return list.map((entry) => {
    const candidate = parseCandidate(entry)
    if (candidate?.kind !== "model") return entry
    if (keepExplicit && candidate.ref.variant !== undefined) return entry
    const model = findModel(models, candidate.ref)
    const bare = `${candidate.ref.providerID}/${candidate.ref.id}`
    if (effort === "auto") return model === undefined ? entry : bare
    if (model === undefined) return entry
    const variant = nearestVariant(model.variants, effort)
    return variant === undefined ? bare : `${bare}#${variant}`
  })
}

const modelKey = (ref: Pick<ModelRef, "providerID" | "id">): string => `${ref.providerID}/${ref.id}`

/** The price a model is ranked by: its own when metered, else the reference price of its canonical id. */
export function priceOf(model: CatalogModel, refs: ReferenceIndex): number | undefined {
  return billingOf(model) === "metered" ? basePrice(model) : refs.get(canonical(model.id).key)?.price
}

/** Classes for every listed model: lineup rank where derived, else by price against the lineup of its provider and vendor. */
export function classify(models: ReadonlyArray<CatalogModel>, refs: ReferenceIndex, derived: Derived, premium = DEFAULT_PREMIUM): Record<string, ModelClass> {
  const classes: Record<string, ModelClass> = {}
  for (const model of models) {
    const price = priceOf(model, refs)
    const entry: ModelClass = { billing: billingOf(model), premium: price !== undefined && price >= premium }
    if (price !== undefined) entry.price = price
    const rank = lineupRank(model, derived)
    if (rank !== undefined) entry.rank = rank
    else if (price !== undefined) {
      const vendor = vendorOf(model)
      const lineup = derived.lineups.find((l) => l[0]?.model.providerID === model.providerID && l[0]?.vendor === vendor)
      if (lineup !== undefined && lineup.length > 1) {
        const strong = (lineup[lineup.length - 1] as { price: number }).price
        const cheap = (lineup[0] as { price: number }).price
        entry.rank = price >= strong ? 2 : price <= cheap ? 0 : 1
      }
    }
    classes[modelKey(model)] = entry
  }
  return classes
}

/** A cost label for the spawner. */
export function costLabel(entry: ModelClass | undefined): string {
  if (entry === undefined) return "cost unknown"
  if (entry.billing === "free") return "free"
  const price = entry.price === undefined ? "" : `$${entry.price}/M input tokens`
  if (entry.billing === "subscription") return `subscription${price === "" ? "" : `, list price ${price}`}`
  return price === "" ? "metered, cost unknown" : `metered, ${price}`
}

/** Every model entry of `name`, `@links` expanded depth-first, in order. */
export function expandRole(roles: Readonly<Record<string, ReadonlyArray<string>>>, name: string): string[] {
  const out: string[] = []
  const walk = (current: string, chain: string[]) => {
    for (const entry of roles[current] ?? []) {
      const candidate = parseCandidate(entry)
      if (candidate === undefined) continue
      if (candidate.kind === "model") out.push(entry)
      else if (!chain.includes(candidate.role) && Object.hasOwn(roles, candidate.role)) walk(candidate.role, [...chain, candidate.role])
    }
  }
  walk(name, [name])
  return out
}

/** Build the resolution map and tier table from the settings, the available models and the reference prices. */
export function buildTiers(settings: TierSettings, models: ReadonlyArray<CatalogModel>, refs: ReferenceIndex): TierSet {
  const usable = models.filter((m) => m.enabled !== false)
  const derived = deriveTiers(usable, refs, settings.derive)
  const roles: Record<string, string[]> = {}
  const sources: Record<string, TierSource> = {}
  const effortOf = (name: string): string | undefined => settings.tiers[name]?.effort ?? DEFAULT_TIER_EFFORT[name]

  const customLegacy = Object.keys(settings.legacy).filter(
    (name) => !Object.hasOwn(TIER_ALIASES, name) && !INHERIT_NAMES.includes(name) && !(BUILTIN_TIERS as readonly string[]).includes(name),
  )
  const custom = [...new Set([...Object.keys(settings.tiers), ...customLegacy])]
    .filter((name) => !(BUILTIN_TIERS as readonly string[]).includes(name) && !Object.hasOwn(TIER_ALIASES, name))
    .sort()
  const names = [...BUILTIN_TIERS, ...custom]

  /** A tier's own candidates: configured, else a legacy role, else derived. `undefined` when it borrows another tier. */
  const own = (name: string): string[] | undefined => {
    const config = settings.tiers[name]
    if (Array.isArray(config?.model)) {
      sources[name] = "config"
      return withEffort(config.model, effortOf(name), usable, true)
    }
    const seed = seedsOf(name).find((role) => Object.hasOwn(settings.legacy, role))
    if (seed !== undefined && config?.model !== "auto") {
      sources[name] = "roles"
      const legacy = settings.legacy[seed] ?? []
      return config?.effort === undefined ? [...legacy] : withEffort(legacy, config.effort, usable, true)
    }
    if (name === "cheap" || name === "standard" || name === "strong") {
      sources[name] = "derived"
      const effort = effortOf(name)
      return derived.tiers[name].map((r) => candidateFor(r.model, effort === "auto" ? undefined : effort))
    }
    return undefined
  }
  for (const name of ["cheap", "standard", "strong"]) roles[name] = own(name) ?? []
  for (const name of ["reviewer", ...custom]) {
    const list = own(name)
    if (list !== undefined) {
      roles[name] = list
      continue
    }
    const base = name === "reviewer" ? "strong" : "standard"
    sources[name] = base
    roles[name] = withEffort(roles[base] ?? [], effortOf(name), usable)
  }

  // Old role names keep resolving: verbatim when `roles` lists them, else through their tier.
  for (const [name, list] of Object.entries(settings.legacy)) if (!Object.hasOwn(roles, name) && !INHERIT_NAMES.includes(name)) roles[name] = [...list]
  for (const [alias, { tier, effort }] of Object.entries(TIER_ALIASES)) {
    if (Object.hasOwn(roles, alias)) continue
    roles[alias] = effort === undefined ? [`@${tier}`] : withEffort(roles[tier] ?? [], effort, usable)
  }

  const classes = classify(usable, refs, derived, settings.derive.premium)
  for (const entry of expandRole(roles, "strong")) {
    const candidate = parseCandidate(entry)
    if (candidate?.kind !== "model") continue
    const known = classes[modelKey(candidate.ref)]
    if (known !== undefined && known.rank === undefined) known.rank = 2
  }

  const tiers: Record<string, TierMeta> = {}
  for (const name of names) {
    const config = settings.tiers[name]
    const seedPurpose = seedsOf(name)
      .map((role) => settings.purposes[role])
      .find((text) => text !== undefined)
    const purpose = config?.purpose ?? seedPurpose ?? TIER_PURPOSE[name]
    const head = expandRole(roles, name)
      .map((entry) => parseCandidate(entry))
      .find((c) => c?.kind === "model" && usable.some((m) => m.providerID === c.ref.providerID && m.id === c.ref.id))
    const meta: TierMeta = {
      purpose: purpose ?? `work that suits the '${name}' tier`,
      distinctVendor: config?.distinctVendor ?? name === "reviewer",
      source: sources[name] ?? "config",
      cost: head?.kind === "model" ? costLabel(classes[modelKey(head.ref)]) : "no model available now; the agent's own model applies",
    }
    if (purpose === undefined) meta.purposeMissing = true
    // A legacy role list is used verbatim, so no tier effort applies to it.
    const effort = meta.source === "roles" ? config?.effort : effortOf(name)
    if (effort !== undefined) meta.effort = effort
    tiers[name] = meta
  }
  return { roles, tiers, classes, derived }
}

/** The tier table entry for a tier or one of its aliases. */
export function tierMeta(options: Pick<Options, "tiers">, name: string): TierMeta | undefined {
  return options.tiers?.[name] ?? options.tiers?.[tierOf(name)]
}

/** Whether a model's derived class makes it expensive: premium, priced at or above `premium`. */
export function isExpensiveClass(ref: Pick<ModelRef, "providerID" | "id">, classes: Readonly<Record<string, ModelClass>> | undefined): boolean {
  return classes?.[modelKey(ref)]?.premium === true
}

/** A model's lineup rank, premium counting as strong. */
export function rankOf(ref: Pick<ModelRef, "providerID" | "id">, classes: Readonly<Record<string, ModelClass>> | undefined): number | undefined {
  const entry = classes?.[modelKey(ref)]
  if (entry === undefined) return undefined
  return entry.premium ? 2 : entry.rank
}

/**
 * Resolve a tier (or alias). With `distinctVendor` and a known caller vendor, candidates
 * from another vendor come first; the rest keep their order behind them.
 */
export function resolveTier(
  options: Pick<Options, "roles" | "tiers">,
  available: ReadonlyArray<AvailableModel>,
  name: string,
  health?: HealthView,
  callerVendor?: string,
): Resolution {
  const meta = tierMeta(options, name)
  if (meta?.distinctVendor !== true || callerVendor === undefined || !Object.hasOwn(options.roles, name))
    return resolveRole(options.roles, available, name, health)
  const flat = expandRole(options.roles, name)
  const other = flat.filter((entry) => {
    const candidate = parseCandidate(entry)
    return candidate?.kind === "model" && vendorOf(candidate.ref) !== callerVendor
  })
  const same = flat.filter((entry) => !other.includes(entry))
  return resolveRole({ ...options.roles, [name]: [...other, ...same] }, available, name, health)
}
