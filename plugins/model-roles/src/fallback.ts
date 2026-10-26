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

/** How long the retry hook waits for `session.switchModel` before leaving the host's decision alone. */
export const DEFAULT_SWITCH_TIMEOUT_MS = 2_000

export type RetryFacts = {
  options: Options
  available: ReadonlyArray<AvailableModel>
  /** Health after the failed model was marked. */
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
 * (throttling, overload, an outage) within the host's retry budget. Permanent ones
 * (spent quota, auth, an unknown model, a content filter) switch at once.
 */
export function staysOnModel(kind: FailureClass, attempt: number, hostRetries: number): boolean {
  return isTransient(kind) && attempt - 1 <= hostRetries
}

/**
 * The model the retry hook switches a failing request to: the next healthy candidate
 * of the session's role. Never a model that is cooling down, so two failing models
 * cannot trade places; when nothing healthy is left the host's own decision stands.
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

/** What happened and what the role now resolves to. */
export function failureNote(facts: NoteFacts): string {
  const scope = facts.scope ?? failureScope(facts.kind)
  const who = scope === "provider" ? `every ${facts.failed.providerID} model` : "it"
  const head = `Model ${label(facts.failed)} failed (${facts.kind}); ${who} sits out new resolutions for ${duration(facts.cooldownMs)}.`
  if (facts.target === undefined) return `${head} No other candidate is available for it.`
  return `${head} Role ${facts.target.role} now resolves to ${label(facts.target.model)}.`
}

/** The note for a request the retry hook moved to another model. */
export function switchNote(facts: NoteFacts & { target: { role: string; model: ModelRef } }): string {
  return `${failureNote(facts)} The request was retried on ${label(facts.target.model)}.`
}

export type SubagentNoteFacts = NoteFacts & {
  agent: string | undefined
  /** The role the spawn passed, when it passed one. */
  spawnRole?: string
  /** The child session, when it was switched to the next model and can be resumed. */
  resumable?: string
}

export function subagentNote(facts: SubagentNoteFacts): string {
  const who = facts.agent === undefined ? "A subagent" : `Subagent '${facts.agent}'`
  let retry: string
  if (facts.target === undefined) retry = "Retrying it would hit the same model; pick another agent or role."
  else if (facts.spawnRole !== undefined) {
    retry = `Spawn it again with role: "${facts.spawnRole}"; that role now runs ${label(facts.target.model)}.`
    if (facts.resumable !== undefined) retry += ` Or resume it with sessionID ${facts.resumable}; it was switched to that model.`
  } else retry = "The spawn may be retried: it now resolves to the next model."
  return `${who} failed. ${failureNote(facts)} ${retry}`
}
