/**
 * `model_roles_check`: every role candidate against the full model list, and every
 * role-bearing agent's resolved model. Pure, so a script can call it with the same
 * options and a `model.list` dump.
 */

import type { Derived } from "./catalog.ts"
import { duration } from "./fallback.ts"
import { type GuardModel, tierNames } from "./guard.ts"
import { type FailureClass, type FailureReason, type FailureScope, type HealthState, healthEntry, healthView } from "./health.ts"
import {
  type AgentLike,
  type AvailableModel,
  type ModelRef,
  modelText,
  type Options,
  parseCandidate,
  resolveRole,
  roleOf,
  userPin,
} from "./resolve.ts"
import { describeChoice, type RoleChoice, roleChoices } from "./spawn-role.ts"
import { type TierMeta, tierOf } from "./tiers.ts"

export type CandidateStatus =
  | { status: "available" }
  | { status: "unhealthy"; until: number; reason: FailureReason }
  | { status: "unknown-id" }
  | { status: "unknown-variant"; variants: string[] }
  | { status: "provider-unavailable" }
  | { status: "role-link"; role: string; known: boolean }
  | { status: "invalid" }

export type CandidateReport = { entry: string } & CandidateStatus

export type RoleReport = {
  role: string
  candidates: CandidateReport[]
  resolved?: ModelRef
  degraded?: true
  /** The tier table entry, for a tier. */
  tier?: TierMeta
}

/** `pinned`: `own` is the user's pin, so the tier does not apply. */
export type AgentReport = { id: string; role: string; resolved?: ModelRef; own?: ModelRef; pinned?: true }

/** `choices`: the values the `subagent` tool's `tier` parameter offers. */
export type CheckReport = {
  roles: RoleReport[]
  agents: AgentReport[]
  choices: RoleChoice[]
  /** The derived lineups and what the derivation dropped, when tiers are derived. */
  derived?: Pick<Derived, "lineups" | "dropped">
  warnings: string[]
}

/** The names the check reports: tiers first, then old role names with a list of their own. */
function reportedNames(options: Options): string[] {
  if (options.tiers === undefined) return Object.keys(options.roles).sort()
  const tiers = tierNames(options)
  const rest = Object.keys(options.roles)
    .filter((name) => !tiers.includes(name))
    .filter((name) => {
      const list = options.roles[name] ?? []
      return !(list.length === 1 && list[0] === `@${tierOf(name)}`)
    })
    .sort()
  return [...tiers, ...rest]
}

/** One candidate's status against every model the host lists, enabled or not. */
export function candidateStatus(
  entry: string,
  models: ReadonlyArray<AvailableModel>,
  roles: Options["roles"],
  health: HealthState,
  now: number,
): CandidateStatus {
  const candidate = parseCandidate(entry)
  if (candidate === undefined) return { status: "invalid" }
  if (candidate.kind === "role") return { status: "role-link", role: candidate.role, known: Object.hasOwn(roles, candidate.role) }
  const { ref } = candidate
  const fromProvider = models.filter((m) => m.providerID === ref.providerID)
  const model = fromProvider.find((m) => m.id === ref.id)
  if (model === undefined) return fromProvider.length === 0 ? { status: "provider-unavailable" } : { status: "unknown-id" }
  if (ref.variant !== undefined && !(model.variants ?? []).some((v) => v.id === ref.variant))
    return { status: "unknown-variant", variants: (model.variants ?? []).map((v) => v.id) }
  if (model.enabled === false) return { status: "provider-unavailable" }
  const entryHealth = healthEntry(health, ref, now)
  if (entryHealth !== undefined)
    return { status: "unhealthy", until: entryHealth.until, reason: entryHealth.reason }
  return { status: "available" }
}

export function checkRoles(
  options: Options,
  models: ReadonlyArray<GuardModel>,
  agents: ReadonlyArray<AgentLike>,
  health: HealthState = {},
  now = Date.now(),
  purposes: Readonly<Record<string, string>> = {},
  derived?: Pick<Derived, "lineups" | "dropped">,
): CheckReport {
  const view = healthView(health, now)
  const roles = reportedNames(options)
    .map((role): RoleReport => {
      const resolution = resolveRole(options.roles, models, role, view)
      const report: RoleReport = {
        role,
        candidates: (options.roles[role] ?? []).map((entry) => ({
          entry,
          ...candidateStatus(entry, models, options.roles, health, now),
        })),
      }
      if (resolution.model !== undefined) report.resolved = resolution.model
      if (resolution.model !== undefined && resolution.unhealthy) report.degraded = true
      const tier = options.tiers?.[role]
      if (tier !== undefined) report.tier = tier
      return report
    })
  const warnings: string[] = []
  for (const [name, tier] of Object.entries(options.tiers ?? {})) {
    if (tier.purposeMissing) warnings.push(`Tier ${name} has no purpose; set tiers.${name}.purpose so the spawner knows when to pick it.`)
    if ((options.roles[name] ?? []).length === 0) warnings.push(`Tier ${name} has no candidates on this machine.`)
  }
  const agentReports: AgentReport[] = []
  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    const role = roleOf(agent, options.agents, options.implicit)
    if (role === undefined) continue
    const report: AgentReport = { id: agent.id, role }
    const resolved = resolveRole(options.roles, models, role, view).model
    if (resolved !== undefined) report.resolved = resolved
    if (agent.model !== undefined) report.own = agent.model
    if (userPin(agent) !== undefined) report.pinned = true
    agentReports.push(report)
  }
  const report: CheckReport = { roles, agents: agentReports, choices: roleChoices(options, models, purposes), warnings }
  if (derived !== undefined) report.derived = { lineups: derived.lineups, dropped: derived.dropped }
  return report
}

/** How many dropped models the check names per reason. */
export const DROPPED_LIMIT = 12

function formatDerived(derived: Pick<Derived, "lineups" | "dropped">): string[] {
  const lines = ["", "Derived lineups (cheapest first):"]
  if (derived.lineups.length === 0) lines.push("  (none: no listed model passed the rules)")
  for (const lineup of derived.lineups) {
    const head = lineup[0]
    if (head === undefined) continue
    lines.push(
      `  - ${head.model.providerID} ${head.vendor}: ${lineup.map((r) => `${r.model.id} (${r.billing}, $${r.price}/M)`).join(" < ")}`,
    )
  }
  const byReason = new Map<string, string[]>()
  for (const entry of derived.dropped) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.ref])
  if (byReason.size > 0) lines.push("", "Dropped from derivation:")
  for (const [reason, refs] of [...byReason].sort((a, b) => a[0].localeCompare(b[0]))) {
    const more = refs.length > DROPPED_LIMIT ? `; ${refs.length - DROPPED_LIMIT} more` : ""
    lines.push(`  - ${reason} (${refs.length}): ${refs.slice(0, DROPPED_LIMIT).join(", ")}${more}`)
  }
  return lines
}

const label = modelText

/** A candidate status in words, as the check prints it. */
export function describeCandidate(candidate: CandidateStatus): string {
  switch (candidate.status) {
    case "available":
      return "available"
    case "unhealthy":
      return `unhealthy until ${new Date(candidate.until).toISOString()}${candidate.reason ? ` (${candidate.reason})` : ""}`
    case "unknown-id":
      return "unknown id: the provider lists no such model"
    case "unknown-variant":
      return `unknown variant (has: ${candidate.variants.join(", ") || "none"})`
    case "provider-unavailable":
      return "provider unavailable (not connected, no credentials, or denied by policy)"
    case "role-link":
      return candidate.known ? `link to role ${candidate.role}` : `link to unknown role ${candidate.role}`
    case "invalid":
      return "invalid: expected provider/model, provider/model#variant or @role"
  }
}

/** Cooldown starts kept for the "Recent health" section. */
export const HEALTH_HISTORY_LIMIT = 10

/** One cooldown of a model or provider. Holds the failure class only, never error text. */
export type HealthEvent = {
  /** When the cooldown started. */
  at: number
  /** `provider/model`, or `provider/*` for a provider-wide cooldown. */
  subject: string
  scope: FailureScope
  kind: FailureClass
  cooldownMs: number
  /** When the cooldown was seen to end early, by a successful call. */
  recoveredAt?: number
}

/**
 * `history` (newest first, at most `limit`) with a cooldown of `subject` recorded. A cooldown
 * that extends one still open for the same subject updates it instead of adding a second.
 */
export function recordCooldown(
  history: ReadonlyArray<HealthEvent>,
  event: Omit<HealthEvent, "recoveredAt">,
  limit = HEALTH_HISTORY_LIMIT,
): HealthEvent[] {
  const open = history.findIndex((e) => e.subject === event.subject && e.recoveredAt === undefined && e.at + e.cooldownMs > event.at)
  if (open >= 0) {
    const prior = history[open] as HealthEvent
    const merged: HealthEvent = { ...prior, kind: event.kind, cooldownMs: event.at + event.cooldownMs - prior.at }
    return history.map((e, i) => (i === open ? merged : e)).slice(0, limit)
  }
  return [event, ...history].slice(0, limit)
}

/** `history` with every open cooldown of `providerID` (its models and the provider itself) ended at `at`, if `at` is after it started. */
export function recordRecovery(history: ReadonlyArray<HealthEvent>, providerID: string, at: number): HealthEvent[] {
  return history.map((e) =>
    e.recoveredAt === undefined && e.at < at && e.at + e.cooldownMs > at && e.subject.startsWith(`${providerID}/`) ? { ...e, recoveredAt: at } : e,
  )
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 19)

/** The "Recent health" section, newest first; nothing when there is no history. */
export function formatHealthHistory(history: ReadonlyArray<HealthEvent>, now: number): string[] {
  if (history.length === 0) return []
  const lines = ["", "Recent health (newest first):"]
  for (const e of history) {
    const end = e.recoveredAt ?? (e.at + e.cooldownMs <= now ? e.at + e.cooldownMs : undefined)
    const who = e.scope === "provider" ? `provider ${e.subject.split("/", 1)[0]}` : `model ${e.subject}`
    lines.push(`  - ${clock(e.at)} ${who}: ${e.kind}, cooldown ${duration(e.cooldownMs)}, ${end === undefined ? "still out" : `recovered ${clock(end)}`}`)
  }
  return lines
}

/** The check as text for the model. */
export function formatCheck(report: CheckReport): string {
  const lines: string[] = []
  if (report.roles.length === 0) lines.push("No roles configured.")
  for (const role of report.roles) {
    const resolved =
      role.resolved === undefined ? "nothing available" : `${label(role.resolved)}${role.degraded ? " (every candidate unhealthy; least recently failed)" : ""}`
    if (role.tier !== undefined) {
      const facts = [role.tier.source, role.tier.effort ? `effort ${role.tier.effort}` : "", role.tier.distinctVendor ? "another vendor first" : ""]
        .filter((f) => f !== "")
        .join(", ")
      lines.push(`Tier ${role.role} (${facts}) → ${resolved}`)
    } else lines.push(`Role ${role.role} → ${resolved}`)
    for (const candidate of role.candidates) lines.push(`  - ${candidate.entry}: ${describeCandidate(candidate)}`)
  }
  if (report.agents.length > 0) {
    lines.push("", "Agents:")
    for (const agent of report.agents) {
      const target =
        agent.pinned && agent.own !== undefined
          ? `${label(agent.own)} (pinned in config; tier not applied)`
          : agent.resolved !== undefined
            ? label(agent.resolved)
            : agent.own !== undefined
              ? `${label(agent.own)} (own model)`
              : "inherits the session model"
      lines.push(`  - ${agent.id} (role ${agent.role}) → ${target}`)
    }
  }
  if (report.choices.length > 0) {
    lines.push("", "subagent `tier` parameter:")
    for (const choice of report.choices) lines.push(`  - ${describeChoice(choice)}`)
  }
  if (report.warnings.length > 0) lines.push("", "Warnings:", ...report.warnings.map((w) => `  - ${w}`))
  if (report.derived !== undefined) lines.push(...formatDerived(report.derived))
  return lines.join("\n")
}
