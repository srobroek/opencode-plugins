/**
 * What to do after a model failure: which model a role falls back to, whether the
 * failed session is retried, and the notes the plugin shows. Pure.
 */

import { type FailureClass, healthKey, mayRetry } from "./health.ts"
import {
  type AvailableModel,
  type HealthView,
  type ModelRef,
  type Options,
  parseCandidate,
  resolveRole,
  sameModel,
} from "./resolve.ts"

export const SOURCE = "srobroek.model-roles"

const label = (ref: ModelRef): string => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

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

export type FallbackFacts = {
  isChild: boolean
  retryOnFallback: boolean
  failed: ModelRef
  next: ModelRef | undefined
  lastRetryAt: unknown
  now: number
  windowMs: number
}

export type FallbackAction = "retry" | "notify" | "notify-parent"

export function decideFallback(facts: FallbackFacts): FallbackAction {
  if (facts.isChild) return "notify-parent"
  if (!facts.retryOnFallback || facts.next === undefined || sameModel(facts.next, facts.failed)) return "notify"
  return mayRetry(facts.lastRetryAt, facts.now, facts.windowMs) ? "retry" : "notify"
}

export type NoteFacts = {
  failed: ModelRef
  kind: FailureClass
  cooldownMs: number
  target: { role: string; model: ModelRef } | undefined
}

/** What happened and what the role now resolves to. */
export function failureNote(facts: NoteFacts): string {
  const minutes = Math.round(facts.cooldownMs / 60_000)
  const head = `Model ${label(facts.failed)} failed (${facts.kind}); it sits out new resolutions for ${minutes} min.`
  if (facts.target === undefined) return `${head} No other candidate is available for it.`
  return `${head} Role ${facts.target.role} now resolves to ${label(facts.target.model)}.`
}

export function retryPrompt(facts: NoteFacts & { target: { role: string; model: ModelRef } }): string {
  return `${failureNote(facts)} This session switched to ${label(facts.target.model)}. Continue the previous task from where it stopped.`
}

export function subagentNote(facts: NoteFacts & { agent: string | undefined }): string {
  const who = facts.agent === undefined ? "A subagent" : `Subagent '${facts.agent}'`
  const retry =
    facts.target === undefined
      ? "Retrying it would hit the same model; pick another agent or role."
      : "The spawn may be retried: it now resolves to the next model."
  return `${who} failed. ${failureNote(facts)} ${retry}`
}
