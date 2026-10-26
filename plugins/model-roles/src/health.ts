/**
 * Runtime model health for `srobroek.model-roles`: which failures are the model's or
 * provider's fault, how long a failed model sits out, and when a session may be
 * retried. Pure; the plugin keeps the state in `ctx.storage`.
 */

import { type HealthView, type ModelRef, parseCandidate } from "./resolve.ts"

export const DEFAULT_COOLDOWN_MS = 600_000

/** Storage key for the health map. */
export const HEALTH_KEY = "health"

/** Storage key prefix for the per-session retry stamp. */
export const RETRY_KEY_PREFIX = "retry/"

export type FailureClass = "unavailable" | "auth" | "rate-limit" | "server"

/** The structured error `session.execution.failed` carries, or a tool error's message. */
export type FailureInput = { type?: string; message?: string; status?: number }

export type HealthEntry = { failedAt: number; until: number; reason: string }

/** Health by `provider/model`. A model's variants share its health. */
export type HealthState = Record<string, HealthEntry>

const NOT_MODEL = [
  /context (?:length|window)|maximum context|prompt is too long|too many tokens/i,
  /\b(?:abort(?:ed)?|cancel(?:l)?ed|interrupted)\b/i,
]

const PATTERNS: ReadonlyArray<[FailureClass, RegExp]> = [
  ["unavailable", /model (?:unavailable|not found|not available|is not supported)|unknown model|no such model|model_not_found|not ready|modelnotready/i],
  ["auth", /credential|unauthori[sz]ed|forbidden|access ?denied|api[ _-]?key|authenticat|security token|token (?:has )?expired|permission denied for model/i],
  ["rate-limit", /throttl|rate.?limit|too many requests|quota|insufficient_quota|\b429\b/i],
  ["server", /overloaded|over capacity|service unavailable|bad gateway|gateway timeout|internal server error|server error|serviceunavailable|\b50[0234]\b|\b529\b/i],
]

/**
 * Whether a failure is the model's or provider's, and which kind. User interrupts,
 * tool errors and context overflow are not: another model would fail the same way.
 */
export function classifyFailure(error: FailureInput | undefined): FailureClass | undefined {
  if (error === undefined) return undefined
  const type = (error.type ?? "").toLowerCase()
  if (type === "tool" || type === "user" || type === "aborted" || type === "interrupted") return undefined
  const message = error.message ?? ""
  if (NOT_MODEL.some((pattern) => pattern.test(message))) return undefined
  const status = error.status
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate-limit"
  if (status !== undefined && status >= 500 && status <= 599) return "server"
  for (const [kind, pattern] of PATTERNS) if (pattern.test(message) || pattern.test(type)) return kind
  return undefined
}

/** The model named in a `Model unavailable: provider/model` message. */
export function modelFromError(message: string): ModelRef | undefined {
  const match = /model unavailable:\s*([^\s,;)'"]+)/i.exec(message)
  if (match?.[1] === undefined) return undefined
  const candidate = parseCandidate(match[1].replace(/[.:]+$/, ""))
  return candidate?.kind === "model" ? candidate.ref : undefined
}

export const healthKey = (ref: Pick<ModelRef, "providerID" | "id">): string => `${ref.providerID}/${ref.id}`

/** The stored health map, dropping malformed entries. */
export function readHealth(value: unknown): HealthState {
  const state: HealthState = {}
  if (value === null || typeof value !== "object" || Array.isArray(value)) return state
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue
    const { failedAt, until, reason } = entry as Record<string, unknown>
    if (typeof failedAt === "number" && typeof until === "number")
      state[key] = { failedAt, until, reason: typeof reason === "string" ? reason : "" }
  }
  return state
}

/** A copy of `state` with `ref` cooling down from `now`, and expired entries dropped. */
export function markUnhealthy(
  state: HealthState,
  ref: ModelRef,
  now: number,
  cooldownMs: number,
  reason: string,
): HealthState {
  const next = pruneHealth(state, now)
  next[healthKey(ref)] = { failedAt: now, until: now + cooldownMs, reason }
  return next
}

export function pruneHealth(state: HealthState, now: number): HealthState {
  const next: HealthState = {}
  for (const [key, entry] of Object.entries(state)) if (entry.until > now) next[key] = entry
  return next
}

/** A resolver view of `state` at `now`. */
export function healthView(state: HealthState, now: number): HealthView {
  return (ref) => {
    const entry = state[healthKey(ref)]
    return entry !== undefined && entry.until > now ? entry.failedAt : undefined
  }
}

/** The next time a cooldown ends, after `now`. */
export function nextExpiry(state: HealthState, now: number): number | undefined {
  let next: number | undefined
  for (const entry of Object.values(state)) if (entry.until > now && (next === undefined || entry.until < next)) next = entry.until
  return next
}

/** At most one fallback retry per session per window. */
export function mayRetry(lastRetryAt: unknown, now: number, windowMs: number): boolean {
  return typeof lastRetryAt !== "number" || now - lastRetryAt >= windowMs
}
