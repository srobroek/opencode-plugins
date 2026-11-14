/**
 * The model a child session resolved to, kept for its lifetime: a resume reuses it, so a
 * `/tiers` save or a reload never moves a running child. Pure; the plugin persists it as
 * `spawn-model:<childID>`, next to `spawn-role:<childID>`.
 */

import { textHash } from "./classify.ts"
import { type AvailableModel, type ModelRef, type Options, parseCandidate } from "./resolve.ts"

/** Storage key prefix for a child's resolved model. */
export const SPAWN_MODEL_KEY_PREFIX = "spawn-model:"
export const SNAPSHOT_LIMIT = 1000
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type ModelSnapshot = {
  /** `provider/model#variant` the child runs on. */
  model: string
  tier?: string
  /** `configRevision` of the tier config this was resolved against. */
  configRevision: string
  at: number
  /** Set when failover moved the child off the model it resolved to. */
  failedOver?: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** JSON with object keys sorted, so equal configs give equal text. */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** A stable hash of the effective tier config: the tiers and the candidate lists they resolve through. */
export const configRevision = (options: Pick<Options, "roles" | "tiers">): string =>
  textHash(stable({ roles: options.roles, tiers: options.tiers ?? {} }))

/** A stored snapshot, or `undefined` when it is missing or malformed. */
export function readSnapshot(value: unknown): ModelSnapshot | undefined {
  if (!isRecord(value) || typeof value.model !== "string" || typeof value.configRevision !== "string" || typeof value.at !== "number") return undefined
  if (parseCandidate(value.model)?.kind !== "model") return undefined
  const snapshot: ModelSnapshot = { model: value.model, configRevision: value.configRevision, at: value.at }
  if (typeof value.tier === "string") snapshot.tier = value.tier
  if (value.failedOver === true) snapshot.failedOver = true
  return snapshot
}

/** The model a snapshot names, if it still parses. */
export function snapshotModel(snapshot: ModelSnapshot): ModelRef | undefined {
  const candidate = parseCandidate(snapshot.model)
  return candidate?.kind === "model" ? candidate.ref : undefined
}

/** Why `model` cannot run now (no such model, disabled, or no such variant), or `undefined` when it can. */
export function unavailableReason(model: ModelRef, available: ReadonlyArray<AvailableModel>): string | undefined {
  const listed = available.find((m) => m.providerID === model.providerID && m.id === model.id)
  if (listed === undefined) return "the model is unknown"
  if (listed.enabled === false) return "the model is unavailable"
  if (model.variant !== undefined && !(listed.variants ?? []).some((v) => v.id === model.variant)) return `the model has no variant '${model.variant}'`
  return undefined
}

/** Keys to delete: unreadable or older than `maxAgeMs`, then the oldest beyond `limit`. */
export function staleSnapshots(
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  now: number,
  limit = SNAPSHOT_LIMIT,
  maxAgeMs = SNAPSHOT_MAX_AGE_MS,
): string[] {
  const stale: string[] = []
  const live: Array<{ key: string; at: number }> = []
  for (const { key, value } of entries) {
    const snapshot = readSnapshot(value)
    if (snapshot === undefined || now - snapshot.at > maxAgeMs) stale.push(key)
    else live.push({ key, at: snapshot.at })
  }
  live.sort((a, b) => b.at - a.at)
  for (const { key } of live.slice(limit)) stale.push(key)
  return stale
}
