/**
 * Runtime model health for `srobroek.model-roles`: which failures are the model's or
 * provider's fault, when repeated failures sit a model out and for how long, and when
 * a session may be retried. Pure; the plugin keeps the state in `ctx.storage`.
 */

import { type HealthView, type ModelRef, parseCandidate } from "./resolve.ts"

/** The first cooldown; each further one in a row doubles it. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** The longest cooldown, and how long a model the provider does not serve sits out. */
export const DEFAULT_MAX_COOLDOWN_MS = 600_000

/** How long a spent quota sits out when the provider names no reset time. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 6 * 60 * 60_000

/** Failure episodes within the flap window that sit a model out. */
export const DEFAULT_FLAP_COUNT = 3

/** How long failure episodes count, and how long after a cooldown the next failure doubles it. */
export const DEFAULT_FLAP_WINDOW_MS = 600_000

/** Failures this soon after an episode began belong to it, so parallel requests failing together count once. */
export const EPISODE_MS = 10_000

/** A request is never switched onto a model that failed this recently, so two failing models cannot trade places. */
export const RECENT_MS = 60_000

/** Storage key for the health map. */
export const HEALTH_KEY = "health"

export type FailureClass = "unavailable" | "content-filter" | "auth" | "credentials" | "quota" | "outage" | "rate-limit" | "server"

/** Whether a failure cools down the whole provider or only the model that failed. */
export type FailureScope = "provider" | "model"

const PROVIDER_SCOPED: ReadonlySet<FailureClass> = new Set(["auth", "credentials", "quota", "outage"])

/** Failures retried on the same model first; the rest switch at once. */
const TRANSIENT: ReadonlySet<FailureClass> = new Set(["rate-limit", "server", "outage", "credentials"])

/** Failures that sit out at once instead of after repeated episodes. */
const DECISIVE: ReadonlySet<FailureClass> = new Set(["quota", "unavailable"])

export const failureScope = (kind: FailureClass): FailureScope => (PROVIDER_SCOPED.has(kind) ? "provider" : "model")

export const isTransient = (kind: FailureClass): boolean => TRANSIENT.has(kind)

/** The structured error `session.execution.failed` carries, or a tool error's message. */
export type FailureInput = {
  type?: string
  message?: string
  status?: number
  response?: { body?: unknown }
  /** The host's reading of a `Retry-After` header. */
  retryAfterMs?: number
}

export type HealthEntry = {
  /** The latest failure. */
  failedAt: number
  /** Sits out new resolutions until then; a past time when it is in use. */
  until: number
  reason: string
  /** When each failure episode in the flap window began, oldest first. */
  episodes?: number[]
  /** Cooldowns in a row; the next one lasts `cooldownMs * 2^strikes`. */
  strikes?: number
}

/** Health by `provider/model`. A model's variants share its health. */
export type HealthState = Record<string, HealthEntry>

const NOT_MODEL = [
  /context (?:length|window)|maximum context|prompt is too long|too many tokens/i,
  /\b(?:abort(?:ed)?|cancel(?:l)?ed|interrupted)\b/i,
]

/**
 * Spent quota, which cools the whole provider until it resets. Besides the plain
 * wording, this covers the codes subscription providers send:
 * - ChatGPT (openai/codex `api_bridge.rs`): 429 `usage_limit_reached`, `usage_not_included`,
 *   `credit_balance_exhausted`, `*_spend_limit_exceeded`, `organization_usage_limit_exceeded`.
 * - ChatGPT token sharing (OpenCode 2.1.4 `provider/chatgpt.ts`): `subscription_sharing_usage_limit_exceeded`.
 * - claude-code (`@openchamber/opencode-claude` 1.6.0 `proxy.js`): 429 `claude_session_limit`, and
 *   Claude Code's own "You've hit your session limit" / "Claude AI usage limit reached".
 */
const QUOTA =
  /insufficient_quota|quota (?:exceeded|exhausted|reached)|exceeded (?:your |the )?(?:current )?quota|billing|credit[_ ]balance|out of credits|payment required|usage[_ ]limit|usage_not_included|spend_limit_exceeded|session[_ ]limit|(?:weekly|daily|monthly|5-hour) (?:usage )?limit|plan limit|\b(?:hit|reached) your [^·\n]*?limit/i

/** OpenCode's failure types for a spent quota. */
const QUOTA_TYPE = /^provider\.(?:quota|free-limit)$/

const PATTERNS: ReadonlyArray<[FailureClass, RegExp]> = [
  ["quota", QUOTA],
  ["content-filter", /content[_ -]?(?:filter|policy|management policy)|blocked by (?:the )?safety|safety (?:filter|system)|responsible ai polic/i],
  // Loading credentials locally (the AWS chain, a credential_process helper) failed: no request was sent.
  ["credentials", /credential (?:chain|provider|process)|credential_process|(?:could not|unable to|failed to|error when|error) (?:load|locat|resolv|refresh|retriev)\w* credentials/i],
  ["outage", /econnrefused|enotfound|econnreset|getaddrinfo|connection refused|unable to connect|fetch failed|network error|socket hang up/i],
  ["unavailable", /model (?:unavailable|not found|not available|is not supported)|unknown model|no such model|model_not_found|model identifier is invalid|not ready|modelnotready/i],
  ["auth", /credential|unauthori[sz]ed|forbidden|access ?denied|api[ _-]?key|authenticat|security token|token (?:has )?expired|sso session|permission denied for model/i],
  ["rate-limit", /throttl|rate.?limit|too many requests|\b429\b/i],
  ["server", /overloaded|over capacity|service unavailable|bad gateway|gateway timeout|internal server error|server error|serviceunavailable|\b50[0234]\b|\b529\b/i],
]

const bodyText = (error: FailureInput): string => {
  const body = error.response?.body
  return typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body)
}

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
  if (status === 402 || QUOTA_TYPE.test(type) || QUOTA.test(message) || QUOTA.test(bodyText(error))) return "quota"
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
 * When a spent quota resets, if the error says: an ISO time after "reset", a unix
 * `reset`/`resets_at` timestamp, a `resets_in_seconds`/`retry_after` count of
 * seconds, a `retry-after`/`resets in` duration such as `3h 20m` or `90 seconds`,
 * or the host's `retryAfterMs`. Only times in the future count.
 */
export function quotaReset(error: FailureInput, now: number): number | undefined {
  const text = `${error.message ?? ""} ${bodyText(error)}`
  const iso = /reset\w*["':\s]*(?:at|on)?\s*["']?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text)?.[1]
  if (iso !== undefined) {
    const at = Date.parse(iso)
    if (Number.isFinite(at) && at > now) return at
  }
  const unix = /(?:reset\w*["':\s]+|limit reached\|)(\d{10})\b/i.exec(text)?.[1]
  if (unix !== undefined) {
    const at = Number(unix) * 1_000
    if (at > now) return at
  }
  const seconds = /(?:resets?_?in_?seconds|retry[-_ ]?after)["':\s]+(\d+(?:\.\d+)?)(?![\d.]|\s*[a-z])/i.exec(text)?.[1]
  if (seconds !== undefined && Number(seconds) > 0) return now + Number(seconds) * 1_000
  const span = /(?:reset\w*|retry[- ]after|try again)\s*(?:in|:)?\s*((?:\d+(?:\.\d+)?\s*(?:d|h|m|s)[a-z]*[\s,]*(?:and\s*)?)+)/i.exec(text)?.[1]
  if (span !== undefined) {
    let total = 0
    for (const match of span.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) total += Number(match[1]) * (DURATION_UNITS[(match[2] ?? "").toLowerCase()] ?? 0)
    if (total > 0) return now + total
  }
  if (error.retryAfterMs !== undefined && error.retryAfterMs > 0) return now + error.retryAfterMs
  return undefined
}

/** When failures sit a model out, and for how long. */
export type HealthPolicy = {
  /** The first cooldown; each further one in a row doubles it. */
  cooldownMs: number
  /** The longest cooldown. */
  maxCooldownMs: number
  /** How long a spent quota sits out when the provider names no reset time. */
  quotaCooldownMs: number
  /** Failure episodes within `flapWindowMs` that sit a model out. */
  flapCount: number
  /** How long failure episodes count, and how long after a cooldown the next failure doubles it. */
  flapWindowMs: number
}

/**
 * How long a failure sits out once it does: a spent quota until its reset, a model the
 * provider does not serve for the longest cooldown, anything else for `cooldownMs`
 * doubled for each cooldown in a row (`strikes`), at most `maxCooldownMs`.
 */
export function cooldownFor(kind: FailureClass, error: FailureInput, now: number, policy: HealthPolicy, strikes = 0): number {
  if (kind === "quota") {
    const reset = quotaReset(error, now)
    return reset === undefined ? policy.quotaCooldownMs : reset - now
  }
  if (kind === "unavailable") return policy.maxCooldownMs
  return Math.min(policy.maxCooldownMs, policy.cooldownMs * 2 ** strikes)
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** The stored health map, dropping malformed entries. */
export function readHealth(value: unknown): HealthState {
  const state: HealthState = {}
  if (value === null || typeof value !== "object" || Array.isArray(value)) return state
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue
    const { failedAt, until, reason, episodes, strikes } = entry as Record<string, unknown>
    if (typeof failedAt !== "number" || typeof until !== "number") continue
    const read: HealthEntry = { failedAt, until, reason: typeof reason === "string" ? reason : "" }
    if (Array.isArray(episodes) && episodes.every(isTime)) read.episodes = episodes
    if (typeof strikes === "number" && Number.isInteger(strikes) && strikes > 0) read.strikes = strikes
    state[key] = read
  }
  return state
}

/**
 * A copy of `state` with `ref` (or, for a provider-scoped failure, its whole provider)
 * sitting out for `cooldownMs` from `now`, and expired entries dropped.
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

export type FailureRecord = {
  state: HealthState
  /** How long the model or provider now sits out; 0 while it stays in use. */
  cooldownMs: number
  /** Whether this failure started or extended a cooldown, so tiers resolve differently. */
  tripped: boolean
}

/**
 * Record a failure of `ref` (or, for a provider-scoped kind, its provider). A spent quota
 * or a model the provider does not serve sits out at once. Anything else stays in use
 * until it has failed in `flapCount` episodes within `flapWindowMs`: a burst of parallel
 * failures is one episode, a blip that clears is not enough, and a model that keeps
 * failing or keeps coming back and failing again is. After a cooldown the next failure
 * episode within the flap window starts the next one, twice as long.
 */
export function recordFailure(
  state: HealthState,
  ref: ModelRef,
  kind: FailureClass,
  error: FailureInput,
  now: number,
  policy: HealthPolicy,
  reason: string,
): FailureRecord {
  const next = pruneHealth(state, now, policy.flapWindowMs)
  const key = failureScope(kind) === "provider" ? providerKey(ref.providerID) : healthKey(ref)
  const prior = next[key]
  const strikes = prior?.strikes ?? 0
  if (prior !== undefined && prior.until > now) {
    // Already sitting out: only a quota that resets later than the cooldown moves it.
    const until = kind === "quota" ? Math.max(prior.until, now + cooldownFor(kind, error, now, policy)) : prior.until
    next[key] = { ...prior, failedAt: now, ...(until > prior.until ? { until, reason } : {}) }
    return { state: next, cooldownMs: until - now, tripped: until > prior.until }
  }
  const episodes = (prior?.episodes ?? []).filter((at) => now - at < policy.flapWindowMs)
  const last = episodes.at(-1)
  const fresh = last === undefined || now - last >= EPISODE_MS
  if (fresh) episodes.push(now)
  const trips = DECISIVE.has(kind) || episodes.length >= policy.flapCount || (strikes > 0 && fresh)
  const cooldownMs = trips ? cooldownFor(kind, error, now, policy, strikes) : 0
  if (cooldownMs <= 0) {
    next[key] = { failedAt: now, until: prior?.until ?? now, reason, episodes, ...(strikes > 0 ? { strikes } : {}) }
    return { state: next, cooldownMs: 0, tripped: false }
  }
  next[key] = { failedAt: now, until: now + cooldownMs, reason, episodes: [], strikes: kind === "quota" ? strikes : strikes + 1 }
  return { state: next, cooldownMs, tripped: true }
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

/** `state` without the entries that have sat out their cooldown and, for `keepMs` after it or their last failure, not failed again. */
export function pruneHealth(state: HealthState, now: number, keepMs = 0): HealthState {
  const next: HealthState = {}
  for (const [key, entry] of Object.entries(state)) if (Math.max(entry.until, entry.failedAt) + keepMs > now) next[key] = entry
  return next
}

/**
 * A resolver view of `state` at `now`: models sitting out, and with `recentMs` also those
 * (or whose provider) failed within that span.
 */
export function healthView(state: HealthState, now: number, recentMs = 0): HealthView {
  return (ref) => {
    const live = healthEntry(state, ref, now)?.failedAt
    if (live !== undefined || recentMs <= 0) return live
    let latest: number | undefined
    for (const key of [healthKey(ref), providerKey(ref.providerID)]) {
      const failedAt = state[key]?.failedAt
      if (failedAt !== undefined && now - failedAt < recentMs && (latest === undefined || failedAt > latest)) latest = failedAt
    }
    return latest
  }
}

/** The next time a cooldown ends, after `now`. */
export function nextExpiry(state: HealthState, now: number): number | undefined {
  let next: number | undefined
  for (const entry of Object.values(state)) if (entry.until > now && (next === undefined || entry.until < next)) next = entry.until
  return next
}

