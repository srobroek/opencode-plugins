/**
 * What to do after a model failure: which model a role falls back to, whether the
 * failed session is retried, and the notes the plugin shows. Pure.
 */

import { type FailureClass, type FailureScope, failureScope, healthKey, isTransient } from "./health.ts"
import {
  type AvailableModel,
  type HealthView,
  type ModelRef,
  modelText,
  type Options,
  parseCandidate,
  resolveRole,
} from "./resolve.ts"

export const SOURCE = "srobroek.model-roles"

const label = modelText

/** Roles that list `failed` directly, in name order. */
export function rolesListing(options: Options, failed: ModelRef): string[] {
  return Object.keys(options.roles)
    .sort()
    .filter((role) =>
      (options.roles[role] ?? []).some((entry) => {
        const candidate = parseCandidate(entry)
        return candidate?.kind === "model" && healthKey(candidate.ref) === healthKey(failed)
      }),
    )
}

/**
 * The role to fall back within and the model it now resolves to: the failed agent's
 * own role, else the first role that lists the failed model and now resolves elsewhere.
 */
export function fallbackTarget(
  options: Options,
  available: ReadonlyArray<AvailableModel>,
  health: HealthView,
  role: string | undefined,
  failed: ModelRef,
): { role: string; model: ModelRef } | undefined {
  const within = role !== undefined && Object.hasOwn(options.roles, role) ? [role] : rolesListing(options, failed)
  for (const candidate of within) {
    const model = resolveRole(options.roles, available, candidate, health).model
    if (model !== undefined && healthKey(model) !== healthKey(failed)) return { role: candidate, model }
  }
  return undefined
}

/** Retries the host may spend on the same model for a transient failure before the retry hook switches. */
export const DEFAULT_HOST_RETRIES = 2

/** Retries on the same model for a transient failure the host would not retry, when there is nowhere to switch. */
export const SAME_MODEL_RETRIES = 5

/** How long the retry hook waits for `session.switchModel` before leaving the host's decision alone. */
export const DEFAULT_SWITCH_TIMEOUT_MS = 2_000

export type RetryFacts = {
  options: Options
  available: ReadonlyArray<AvailableModel>
  /** Health after the failed model was recorded, counting recent failures as unhealthy. */
  health: HealthView
  role: string | undefined
  failed: ModelRef
  kind: FailureClass
  /** The attempt the host is about to make: 2 for the first retry. */
  attempt: number
  hostRetries: number
}

/**
 * Whether a failed request should stay on its model for now: a transient failure
 * (throttling, overload, an outage, credentials that did not load) within the host's
 * retry budget. Permanent ones (spent quota, auth, an unknown model, a content filter)
 * switch at once.
 */
export function staysOnModel(kind: FailureClass, attempt: number, hostRetries: number): boolean {
  return isTransient(kind) && attempt - 1 <= hostRetries
}

/**
 * Whether a transient failure the host would not retry is retried on its model anyway:
 * within the host's budget, and after it while there is nowhere to switch, up to
 * `SAME_MODEL_RETRIES` retries.
 */
export function retriesOnModel(kind: FailureClass, attempt: number, hostRetries: number): boolean {
  return isTransient(kind) && attempt - 1 <= Math.max(hostRetries, SAME_MODEL_RETRIES)
}

/** The backoff before retry `attempt` (2 for the first) on the same model: 2 s, doubling, at most 30 s. */
export function retryDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(1, attempt - 1))
}

/**
 * The model the retry hook switches a failing request to: the next healthy candidate
 * of the session's role. Never one that is cooling down or failed recently, so two
 * failing models cannot trade places; when nothing healthy is left the host's own
 * decision stands.
 */
export function retryTarget(facts: RetryFacts): { role: string; model: ModelRef } | undefined {
  if (staysOnModel(facts.kind, facts.attempt, facts.hostRetries)) return undefined
  const within =
    facts.role !== undefined && Object.hasOwn(facts.options.roles, facts.role) ? [facts.role] : rolesListing(facts.options, facts.failed)
  for (const role of within) {
    const resolution = resolveRole(facts.options.roles, facts.available, role, facts.health)
    if (resolution.model === undefined || resolution.unhealthy) continue
    if (healthKey(resolution.model) === healthKey(facts.failed)) continue
    return { role, model: resolution.model }
  }
  return undefined
}

export type NoteFacts = {
  failed: ModelRef
  kind: FailureClass
  /** How long it sits out; 0 while it stays in use. */
  cooldownMs: number
  target: { role: string; model: ModelRef } | undefined
  /** Defaults to the scope of `kind`. */
  scope?: FailureScope
}

/** A cooldown as text: seconds, minutes or hours. */
export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round((ms / 3_600_000) * 10) / 10} h`
}

/** What happened and, when the model now sits out, what its tier resolves to. */
export function failureNote(facts: NoteFacts): string {
  const failed = `Model ${label(facts.failed)} failed (${facts.kind})`
  if (facts.cooldownMs <= 0) return `${failed}; it stays in use unless it keeps failing.`
  const scope = facts.scope ?? failureScope(facts.kind)
  const who = scope === "provider" ? `every ${facts.failed.providerID} model` : "it"
  const head = `${failed}; ${who} sits out new resolutions for ${duration(facts.cooldownMs)}.`
  if (facts.target === undefined) return `${head} No other candidate is available for it.`
  return `${head} Tier ${facts.target.role} now resolves to ${label(facts.target.model)}.`
}

/** The note for a request the retry hook moved to another model. */
export function switchNote(facts: NoteFacts & { target: { role: string; model: ModelRef } }): string {
  return `${failureNote(facts)} The request was retried on ${label(facts.target.model)}.`
}

export type SubagentNoteFacts = NoteFacts & {
  agent: string | undefined
  /** The role the spawn passed, when it passed one. */
  spawnRole?: string
  /** The child session, when it can be resumed: on its own model, or on the next one it was switched to. */
  resumable?: string
}

export function subagentNote(facts: SubagentNoteFacts): string {
  const who = facts.agent === undefined ? "A subagent" : `Subagent '${facts.agent}'`
  let retry: string
  if (facts.cooldownMs <= 0)
    retry = facts.resumable === undefined ? "The spawn may be retried as is." : `Resume it with sessionID ${facts.resumable}, or spawn it again.`
  else if (facts.target === undefined) retry = "Retrying it would hit the same model; pick another agent or tier."
  else if (facts.spawnRole !== undefined) {
    retry = `Spawn it again with tier: "${facts.spawnRole}"; that tier now runs ${label(facts.target.model)}.`
    if (facts.resumable !== undefined) retry += ` Or resume it with sessionID ${facts.resumable}; it was switched to that model.`
  } else retry = "The spawn may be retried: it now resolves to the next model."
  return `${who} failed. ${failureNote(facts)} ${retry}`
}
