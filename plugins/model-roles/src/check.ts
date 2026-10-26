/**
 * `model_roles_check`: every role candidate against the full model list, and every
 * role-bearing agent's resolved model. Pure, so a script can call it with the same
 * options and a `model.list` dump.
 */

import type { GuardModel } from "./guard.ts"
import { type HealthState, healthKey, healthView } from "./health.ts"
import {
  type AgentLike,
  type AvailableModel,
  type ModelRef,
  modelText,
  type Options,
  parseCandidate,
  resolveRole,
  roleOf,
} from "./resolve.ts"
import { describeChoice, type RoleChoice, roleChoices } from "./spawn-role.ts"

export type CandidateStatus =
  | { status: "available" }
  | { status: "unhealthy"; until: number; reason: string }
  | { status: "unknown-id" }
  | { status: "unknown-variant"; variants: string[] }
  | { status: "provider-unavailable" }
  | { status: "role-link"; role: string; known: boolean }
  | { status: "invalid" }

export type CandidateReport = { entry: string } & CandidateStatus

export type RoleReport = { role: string; candidates: CandidateReport[]; resolved?: ModelRef; degraded?: true }

export type AgentReport = { id: string; role: string; resolved?: ModelRef; own?: ModelRef }

/** `choices`: the values the `subagent` tool's `role` parameter offers. */
export type CheckReport = { roles: RoleReport[]; agents: AgentReport[]; choices: RoleChoice[] }

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
  const entryHealth = health[healthKey(ref)]
  if (entryHealth !== undefined && entryHealth.until > now)
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
): CheckReport {
  const view = healthView(health, now)
  const roles = Object.keys(options.roles)
    .sort()
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
      return report
    })
  const agentReports: AgentReport[] = []
  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    const role = roleOf(agent, options.agents)
    if (role === undefined) continue
    const report: AgentReport = { id: agent.id, role }
    const resolved = resolveRole(options.roles, models, role, view).model
    if (resolved !== undefined) report.resolved = resolved
    if (agent.model !== undefined) report.own = agent.model
    agentReports.push(report)
  }
  return { roles, agents: agentReports, choices: roleChoices(options, models, purposes) }
}

const label = modelText

function describe(candidate: CandidateReport): string {
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

/** The check as text for the model. */
export function formatCheck(report: CheckReport): string {
  const lines: string[] = []
  if (report.roles.length === 0) lines.push("No roles configured.")
  for (const role of report.roles) {
    const resolved =
      role.resolved === undefined ? "nothing available" : `${label(role.resolved)}${role.degraded ? " (every candidate unhealthy; least recently failed)" : ""}`
    lines.push(`Role ${role.role} → ${resolved}`)
    for (const candidate of role.candidates) lines.push(`  - ${candidate.entry}: ${describe(candidate)}`)
  }
  if (report.agents.length > 0) {
    lines.push("", "Agents:")
    for (const agent of report.agents) {
      const target = agent.resolved !== undefined ? label(agent.resolved) : agent.own !== undefined ? `${label(agent.own)} (own model)` : "inherits the session model"
      lines.push(`  - ${agent.id} (role ${agent.role}) → ${target}`)
    }
  }
  if (report.choices.length > 0) {
    lines.push("", "subagent `role` parameter:")
    for (const choice of report.choices) lines.push(`  - ${describeChoice(choice)}`)
  }
  return lines.join("\n")
}
