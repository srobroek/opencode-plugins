/**
 * Runtime model health for `srobroek.model-roles`: which failures are the model's or
 * provider's fault, how long a failed model sits out, and when a session may be
 * retried. Pure; the plugin keeps the state in `ctx.storage`.
 */

import { type HealthView, type ModelRef, parseCandidate } from "./resolve.ts"

export const DEFAULT_COOLDOWN_MS = 600_000

/** How long a spent quota sits out when the provider names no reset time. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 6 * 60 * 60_000

/** Storage key for the health map. */
export const HEALTH_KEY = "health"

export type FailureClass = "unavailable" | "content-filter" | "auth" | "quota" | "outage" | "rate-limit" | "server"

/** Whether a failure cools down the whole provider or only the model that failed. */
export type FailureScope = "provider" | "model"

const PROVIDER_SCOPED: ReadonlySet<FailureClass> = new Set(["auth", "quota", "outage"])

/** Failures the host may retry on the same model first; the rest switch at once. */
const TRANSIENT: ReadonlySet<FailureClass> = new Set(["rate-limit", "server", "outage"])

export const failureScope = (kind: FailureClass): FailureScope => (PROVIDER_SCOPED.has(kind) ? "provider" : "model")

export const isTransient = (kind: FailureClass): boolean => TRANSIENT.has(kind)

/** The structured error `session.execution.failed` carries, or a tool error's message. */
export type FailureInput = { type?: string; message?: string; status?: number; response?: { body?: unknown } }

export type HealthEntry = { failedAt: number; until: number; reason: string }

/** Health by `provider/model`. A model's variants share its health. */
export type HealthState = Record<string, HealthEntry>

const NOT_MODEL = [
  /context (?:length|window)|maximum context|prompt is too long|too many tokens/i,
  /\b(?:abort(?:ed)?|cancel(?:l)?ed|interrupted)\b/i,
]

const QUOTA =
  /insufficient_quota|quota (?:exceeded|exhausted|reached)|exceeded (?:your |the )?(?:current )?quota|billing|credit balance|out of credits|payment required|usage limit|(?:weekly|daily|monthly|5-hour) (?:usage )?limit|plan limit/i

const PATTERNS: ReadonlyArray<[FailureClass, RegExp]> = [
  ["quota", QUOTA],
  ["content-filter", /content[_ -]?(?:filter|policy|management policy)|blocked by (?:the )?safety|safety (?:filter|system)|responsible ai polic/i],
  ["outage", /econnrefused|enotfound|econnreset|getaddrinfo|connection refused|unable to connect|fetch failed|network error|socket hang up/i],
  ["unavailable", /model (?:unavailable|not found|not available|is not supported)|unknown model|no such model|model_not_found|model identifier is invalid|not ready|modelnotready/i],
  ["auth", /credential|unauthori[sz]ed|forbidden|access ?denied|api[ _-]?key|authenticat|security token|token (?:has )?expired|sso session|permission denied for model/i],
  ["rate-limit", /throttl|rate.?limit|too many requests|\b429\b/i],
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
  if (status === 402 || QUOTA.test(message)) return "quota"
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

/** The child session a `Subagent failed (sessionID: <id>): ...` tool error names. */
export function childSessionID(message: string): string | undefined {
  return /subagent failed \((?:sessionid:\s*)?([^)\s]+)\)/i.exec(message)?.[1]
}

export const healthKey = (ref: Pick<ModelRef, "providerID" | "id">): string => `${ref.providerID}/${ref.id}`

/** The health key that covers every model of a provider. */
export const providerKey = (providerID: string): string => `${providerID}/*`

const DURATION_UNITS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * When a spent quota resets, if the error says: an ISO time after "reset", a
 * `retry-after`/`resets in` duration such as `3h 20m` or `90 seconds`, or a unix
 * `reset` timestamp. Only times in the future count.
 */
export function quotaReset(error: FailureInput, now: number): number | undefined {
  const body = error.response?.body
  const text = `${error.message ?? ""} ${typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body)}`
  const iso = /reset\w*["':\s]*(?:at|on)?\s*["']?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text)?.[1]
  if (iso !== undefined) {
    const at = Date.parse(iso)
    if (Number.isFinite(at) && at > now) return at
  }
  const unix = /reset\w*["':\s]+(\d{10})\b/i.exec(text)?.[1]
  if (unix !== undefined) {
    const at = Number(unix) * 1_000
    if (at > now) return at
  }
  const span = /(?:reset\w*|retry[- ]after|try again)\s*(?:in|:)?\s*((?:\d+(?:\.\d+)?\s*(?:d|h|m|s)[a-z]*[\s,]*(?:and\s*)?)+)/i.exec(text)?.[1]
  if (span !== undefined) {
    let total = 0
    for (const match of span.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) total += Number(match[1]) * (DURATION_UNITS[(match[2] ?? "").toLowerCase()] ?? 0)
    if (total > 0) return now + total
  }
  return undefined
}

export type CooldownOptions = { cooldownMs: number; quotaCooldownMs: number }

/** How long a failure sits out: a spent quota until its reset, else the configured span. */
export function cooldownFor(kind: FailureClass, error: FailureInput, now: number, options: CooldownOptions): number {
  if (kind !== "quota") return options.cooldownMs
  const reset = quotaReset(error, now)
  return reset === undefined ? options.quotaCooldownMs : reset - now
}

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

/**
 * A copy of `state` with `ref` (or, for a provider-scoped failure, its whole provider)
 * cooling down from `now`, and expired entries dropped.
 */
export function markUnhealthy(
  state: HealthState,
  ref: ModelRef,
  now: number,
  cooldownMs: number,
  reason: string,
  scope: FailureScope = "model",
): HealthState {
  const next = pruneHealth(state, now)
  const key = scope === "provider" ? providerKey(ref.providerID) : healthKey(ref)
  next[key] = { failedAt: now, until: now + cooldownMs, reason }
  return next
}

/** The live entry that covers `ref`: its own or its provider's, whichever failed last. */
export function healthEntry(state: HealthState, ref: Pick<ModelRef, "providerID" | "id">, now: number): HealthEntry | undefined {
  let found: HealthEntry | undefined
  for (const key of [healthKey(ref), providerKey(ref.providerID)]) {
    const entry = state[key]
    if (entry !== undefined && entry.until > now && (found === undefined || entry.failedAt > found.failedAt)) found = entry
  }
  return found
}

export function pruneHealth(state: HealthState, now: number): HealthState {
  const next: HealthState = {}
  for (const [key, entry] of Object.entries(state)) if (entry.until > now) next[key] = entry
  return next
}

/** A resolver view of `state` at `now`. */
export function healthView(state: HealthState, now: number): HealthView {
  return (ref) => healthEntry(state, ref, now)?.failedAt
}

/** The next time a cooldown ends, after `now`. */
export function nextExpiry(state: HealthState, now: number): number | undefined {
  let next: number | undefined
  for (const entry of Object.values(state)) if (entry.until > now && (next === undefined || entry.until < next)) next = entry.until
  return next
}

