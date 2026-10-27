/**
 * Tiers worked out from the model catalog for `srobroek.model-roles`: billing kind,
 * canonical ids, pruning and the per-vendor cheap/standard/strong lineup. Pure, so
 * every rule is tested against real catalog fixtures.
 */

import type { ModelRef } from "./resolve.ts"

/** The part of `Model.Info` tier derivation reads. */
export type CatalogModel = {
  providerID: string
  id: string
  family?: string
  enabled?: boolean
  status?: string
  capabilities?: { tools?: boolean; output?: ReadonlyArray<string> }
  variants?: ReadonlyArray<{ id: string }>
  time?: { released?: number }
  cost?: ReadonlyArray<{ tier?: unknown; input: number; output?: number }>
}

/** What the models.dev first-party records say about a canonical model. */
export type Reference = { family?: string; released?: number; price?: number }

/** First-party reference facts by canonical key. */
export type ReferenceIndex = ReadonlyMap<string, Reference>

export type Billing = "subscription" | "free" | "metered"

/** The tiers the plugin derives from the catalog. */
export const DERIVED_TIERS = ["cheap", "standard", "strong"] as const
export type DerivedTier = (typeof DERIVED_TIERS)[number]

/** Effort per derived tier when the config names none. */
export const DEFAULT_TIER_EFFORT: Readonly<Record<string, string>> = {
  cheap: "low",
  standard: "medium",
  strong: "high",
  reviewer: "high",
}

/** Effort levels, lowest first. Nearest-variant mapping walks this scale. */
export const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/** Price (USD per million input tokens) at or above which a model is premium. */
export const DEFAULT_PREMIUM = 8

/** Families the derivation keeps by default. */
export const DEFAULT_INCLUDE: ReadonlyArray<string> = ["claude", "gpt", "gemini"]

/** A model released this long before the newest one of its provider and vendor is stale. */
export const STALE_MS = 120 * 24 * 60 * 60_000

/** A newer model within this fraction of an older one's price, same provider and vendor, replaces it. */
export const DOMINATED_RATIO = 0.1

/** Providers whose records are the first-party reference for their vendor. */
export const REFERENCE_PROVIDERS: ReadonlyArray<string> = ["anthropic", "openai", "google"]

const SPECIAL = /realtime|image|audio|tts|transcribe|embed|research|preview|search|computer-use|latest|(?:^|-)oss(?:-|$)|live/
const SPEED = /(?:-|:)(?:ultra)?fast$/
const REGION = /^(?:global|us-gov|us|eu|apac|au|ca|jp|in)\./
const VENDOR_PREFIX = /^(anthropic|openai|google|meta|mistral|amazon|cohere|deepseek|qwen|moonshot|xai|zai|minimax|nvidia|writer)\./

export type Canonical = { key: string; vendor: string | undefined; speed: boolean }

/** The model behind a provider-specific id: Bedrock region and vendor prefixes, versions, dates and `[1m]` removed. */
export function canonical(id: string): Canonical {
  let key = id.toLowerCase().replace(REGION, "")
  const prefix = VENDOR_PREFIX.exec(key)?.[1]
  key = key.replace(VENDOR_PREFIX, "").replace(/\[[^\]]*\]$/, "")
  const speed = SPEED.test(key)
  key = key
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d+:\d+$/, "")
    .replace(/-\d{8}$/, "")
  const vendor =
    prefix ??
    (key.startsWith("claude")
      ? "anthropic"
      : /^(?:gpt|o\d)/.test(key)
        ? "openai"
        : key.startsWith("gemini") || key.startsWith("gemma")
          ? "google"
          : undefined)
  return { key, vendor, speed }
}

/** The vendor of a model reference, when its id says. */
export const vendorOf = (ref: Pick<ModelRef, "id">): string | undefined => canonical(ref.id).vendor

/** The base-tier input price, if the model has one. */
export function basePrice(model: Pick<CatalogModel, "cost">): number | undefined {
  const costs = model.cost ?? []
  const base = costs.find((c) => c.tier === undefined) ?? costs[0]
  return typeof base?.input === "number" ? base.input : undefined
}

/** `cost: []` is a flat plan (or unknown), all zero is free, anything else is metered. */
export function billingOf(model: Pick<CatalogModel, "cost">): Billing {
  const costs = model.cost ?? []
  if (costs.length === 0) return "subscription"
  if (costs.every((c) => c.input === 0 && (c.output ?? 0) === 0)) return "free"
  return "metered"
}

/** Reference facts from the first-party provider records, keyed by canonical id. Speed variants are skipped. */
export function buildReferenceIndex(models: Iterable<CatalogModel>): Map<string, Reference> {
  const index = new Map<string, Reference>()
  for (const model of models) {
    if (!REFERENCE_PROVIDERS.includes(model.providerID)) continue
    const { key, speed } = canonical(model.id)
    if (speed || (index.has(key) && model.id !== key)) continue
    const ref: Reference = {}
    if (model.family !== undefined) ref.family = model.family
    if (model.time?.released) ref.released = model.time.released
    const price = basePrice(model)
    if (price !== undefined && billingOf(model) === "metered") ref.price = price
    index.set(key, ref)
  }
  return index
}

/** The variant nearest to `effort` on the effort scale; ties go to the lower one. `undefined` when the model has none. */
export function nearestVariant(variants: ReadonlyArray<{ id: string }> | undefined, effort: string): string | undefined {
  const ids = (variants ?? []).map((v) => v.id)
  if (ids.includes(effort)) return effort
  const want = (EFFORT_SCALE as readonly string[]).indexOf(effort)
  if (want < 0) return undefined
  let best: { id: string; distance: number; rank: number } | undefined
  for (const id of ids) {
    const rank = (EFFORT_SCALE as readonly string[]).indexOf(id)
    if (rank < 0) continue
    const distance = Math.abs(rank - want)
    if (best === undefined || distance < best.distance || (distance === best.distance && rank < best.rank))
      best = { id, distance, rank }
  }
  return best?.id
}

export type DeriveOptions = {
  /** Provider ids, vendors, or `provider/model*` globs; earlier wins at equal billing. */
  prefer?: ReadonlyArray<string>
  /** Same forms as `prefer`; never derived. */
  avoid?: ReadonlyArray<string>
  /** Family prefixes kept (default `claude`, `gpt`, `gemini`). */
  include?: ReadonlyArray<string>
  premium?: number
}

export type DropReason =
  | "disabled"
  | "inactive"
  | "no-tools"
  | "free"
  | "excluded-family"
  | "special-purpose"
  | "speed"
  | "avoided"
  | "unranked"
  | "duplicate-region"
  | "superseded"
  | "stale"
  | "dominated"
  | "premium"

export type Ranked = {
  model: CatalogModel
  key: string
  vendor: string
  family: string
  released: number
  price: number
  billing: Billing
}

export type Derived = {
  /** Ranked models per derived tier, best first for this tier. */
  tiers: Record<DerivedTier, Ranked[]>
  /** The pruned lineup of every (provider, vendor), cheapest first. */
  lineups: Ranked[][]
  dropped: Array<{ ref: string; reason: DropReason }>
}

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i")

/** Whether `pattern` (provider id, vendor, or `provider/model` glob) names this model. */
export function matchesPattern(pattern: string, model: Pick<CatalogModel, "providerID" | "id">, vendor?: string): boolean {
  if (pattern.includes("/") || pattern.includes("*")) return globToRegExp(pattern).test(`${model.providerID}/${model.id}`)
  return pattern === model.providerID || pattern === vendor
}

const releasedOf = (model: CatalogModel, ref: Reference | undefined): number => model.time?.released || ref?.released || 0

function familyOf(model: CatalogModel, key: string, ref: Reference | undefined): string {
  return model.family ?? ref?.family ?? key.replace(/[-.]?\d.*$/, "")
}

/** Region profile preference among the same canonical model on one provider: global, unprefixed, regional. */
const regionRank = (id: string): number => (id.startsWith("global.") ? 0 : REGION.test(id) ? 2 : 1)

const BILLING_ORDER: Readonly<Record<Billing, number>> = { subscription: 0, metered: 1, free: 2 }

/** Index of the first `prefer` entry naming the model; unlisted models sort after listed ones. */
function preferRank(prefer: ReadonlyArray<string>, ranked: Ranked): number {
  const at = prefer.findIndex((p) => matchesPattern(p, ranked.model, ranked.vendor))
  return at < 0 ? prefer.length : at
}

/** Order candidates of one tier across lineups. Strong sorts dearest first, the rest cheapest first. */
export function tierOrder(tier: DerivedTier, prefer: ReadonlyArray<string>) {
  return (a: Ranked, b: Ranked): number =>
    BILLING_ORDER[a.billing] - BILLING_ORDER[b.billing] ||
    preferRank(prefer, a) - preferRank(prefer, b) ||
    (tier === "strong" ? b.price - a.price : a.price - b.price) ||
    b.released - a.released ||
    `${a.model.providerID}/${a.model.id}`.localeCompare(`${b.model.providerID}/${b.model.id}`)
}

/**
 * Derive cheap, standard and strong from the available models. Every model a rule
 * drops is reported with the reason.
 */
export function deriveTiers(models: ReadonlyArray<CatalogModel>, refs: ReferenceIndex, options: DeriveOptions = {}): Derived {
  const dropped: Derived["dropped"] = []
  const drop = (model: CatalogModel, reason: DropReason) => dropped.push({ ref: `${model.providerID}/${model.id}`, reason })
  const include = (options.include ?? DEFAULT_INCLUDE).map((f) => f.toLowerCase())
  const premium = options.premium ?? DEFAULT_PREMIUM
  const prefer = options.prefer ?? []
  const avoid = options.avoid ?? []

  const eligible: Ranked[] = []
  for (const model of models) {
    if (model.enabled === false) {
      drop(model, "disabled")
      continue
    }
    if (model.status !== undefined && model.status !== "active") {
      drop(model, "inactive")
      continue
    }
    const output = model.capabilities?.output
    if (model.capabilities?.tools === false || (output !== undefined && !output.includes("text"))) {
      drop(model, "no-tools")
      continue
    }
    const billing = billingOf(model)
    if (billing === "free") {
      drop(model, "free")
      continue
    }
    const { key, vendor, speed } = canonical(model.id)
    if (vendor === undefined || !include.some((f) => key === f || key.startsWith(`${f}-`))) {
      drop(model, "excluded-family")
      continue
    }
    if (SPECIAL.test(key)) {
      drop(model, "special-purpose")
      continue
    }
    if (speed) {
      drop(model, "speed")
      continue
    }
    if (avoid.some((p) => matchesPattern(p, model, vendor))) {
      drop(model, "avoided")
      continue
    }
    const ref = refs.get(key)
    const price = billing === "metered" ? basePrice(model) : ref?.price
    if (price === undefined) {
      drop(model, "unranked")
      continue
    }
    eligible.push({ model, key, vendor, family: familyOf(model, key, ref), released: releasedOf(model, ref), price, billing })
  }

  const groups = new Map<string, Ranked[]>()
  const push = (map: Map<string, Ranked[]>, k: string, r: Ranked) => map.set(k, [...(map.get(k) ?? []), r])

  // One region profile per canonical model and provider.
  const byKey = new Map<string, Ranked[]>()
  for (const r of eligible) push(byKey, `${r.model.providerID}\0${r.key}`, r)
  const unique: Ranked[] = []
  for (const list of byKey.values()) {
    list.sort((a, b) => regionRank(a.model.id) - regionRank(b.model.id) || a.model.id.localeCompare(b.model.id))
    unique.push(list[0] as Ranked)
    for (const other of list.slice(1)) drop(other.model, "duplicate-region")
  }

  // Newest per family, then the shortest key (the plain model over its service-tier variants).
  const byFamily = new Map<string, Ranked[]>()
  for (const r of unique) push(byFamily, `${r.model.providerID}\0${r.vendor}\0${r.family}`, r)
  const current: Ranked[] = []
  for (const list of byFamily.values()) {
    list.sort((a, b) => b.released - a.released || a.key.length - b.key.length || a.key.localeCompare(b.key))
    current.push(list[0] as Ranked)
    for (const other of list.slice(1)) drop(other.model, "superseded")
  }

  for (const r of current) push(groups, `${r.model.providerID}\0${r.vendor}`, r)
  const lineups: Ranked[][] = []
  for (const list of groups.values()) {
    const newest = Math.max(...list.map((r) => r.released))
    const fresh = list.filter((r) => {
      if (newest - r.released <= STALE_MS) return true
      drop(r.model, "stale")
      return false
    })
    const kept = fresh.filter((r) => {
      const dominated = fresh.some(
        (o) => o !== r && o.released > r.released && Math.abs(o.price - r.price) <= r.price * DOMINATED_RATIO,
      )
      if (dominated) drop(r.model, "dominated")
      return !dominated
    })
    const lineup = kept.filter((r) => {
      if (r.price < premium) return true
      drop(r.model, "premium")
      return false
    })
    lineup.sort((a, b) => a.price - b.price || b.released - a.released || a.model.id.localeCompare(b.model.id))
    if (lineup.length > 0) lineups.push(lineup)
  }

  const tiers: Record<DerivedTier, Ranked[]> = { cheap: [], standard: [], strong: [] }
  for (const lineup of lineups) {
    const first = lineup[0] as Ranked
    const last = lineup[lineup.length - 1] as Ranked
    tiers.cheap.push(first)
    tiers.strong.push(last)
    const middle = lineup.slice(1, -1)
    if (middle.length > 0) tiers.standard.push(...middle)
    else tiers.standard.push(last)
  }
  for (const tier of DERIVED_TIERS) tiers[tier].sort(tierOrder(tier, prefer))
  return { tiers, lineups, dropped }
}

/** `provider/model#variant` for a ranked model at `effort`, or without a variant when it has none near. */
export function candidateFor(model: CatalogModel, effort: string | undefined): string {
  const variant = effort === undefined ? undefined : nearestVariant(model.variants, effort)
  return `${model.providerID}/${model.id}${variant === undefined ? "" : `#${variant}`}`
}

/** Where a model sits in its provider and vendor lineup: 0 cheap, 1 standard, 2 strong. `undefined` when it is not ranked. */
export function lineupRank(ref: Pick<ModelRef, "providerID" | "id">, derived: Pick<Derived, "lineups">): number | undefined {
  for (const lineup of derived.lineups) {
    const at = lineup.findIndex((r) => r.model.providerID === ref.providerID && r.model.id === ref.id)
    if (at < 0) continue
    if (at === lineup.length - 1) return lineup.length === 1 ? 1 : 2
    return at === 0 ? 0 : 1
  }
  return undefined
}
