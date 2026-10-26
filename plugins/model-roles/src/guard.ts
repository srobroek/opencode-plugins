/**
 * Pure subagent-model guard for `srobroek.model-roles`: deny a `subagent` spawn
 * whose target agent would silently inherit an expensive session model.
 */

import {
  type AvailableModel,
  type HealthView,
  type ModelRef,
  type Options,
  parseCandidate,
  resolveRole,
  roleOf,
} from "./resolve.ts"

/** Input cost (USD per million tokens) at or above which `"auto"` counts a model as expensive. */
export const AUTO_THRESHOLD = 4

/** How many alternatives a deny message names. */
export const CATALOG_LIMIT = 12

export type GuardOptions = {
  /** `provider/model` references, or `"auto"` to judge by input cost. */
  expensive: string[] | "auto"
  threshold: number
  /** Agent ids allowed to inherit the session model. */
  allowInherit: string[]
}

export type GuardAgent = {
  id: string
  model?: ModelRef
  mode?: string
  hidden?: boolean
  description?: string
  request?: { headers?: Readonly<Record<string, string>> }
}

export type GuardModel = AvailableModel & {
  cost?: ReadonlyArray<{ tier?: unknown; input: number }>
}

export type GuardFacts = {
  guard: GuardOptions
  options: Options
  /** The agent the spawn names. */
  target: string
  agents: ReadonlyArray<GuardAgent>
  available: ReadonlyArray<GuardModel>
  /** The calling session's model, when known. */
  sessionModel: ModelRef | undefined
  /** Ids of the plugin's `general-<role>` subagents, suggested first. */
  roleAgents?: ReadonlyArray<string>
  /** How the plugin resolves models right now; defaults to plain role resolution. */
  health?: HealthView
}

export type GuardDecision = { allow: true } | { allow: false; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : []

/** Normalise the `guard` option. `undefined` means the guard is off; `true` means defaults. */
export function parseGuard(raw: unknown): GuardOptions | undefined {
  if (raw === undefined || raw === false || raw === null) return undefined
  const input = isRecord(raw) ? raw : {}
  if (input.enabled === false) return undefined
  const list = typeof input.expensive === "string" && input.expensive !== "auto" ? [input.expensive] : strings(input.expensive)
  const expensive = input.expensive === undefined || input.expensive === "auto" ? "auto" : list
  const threshold =
    typeof input.threshold === "number" && Number.isFinite(input.threshold) && input.threshold > 0
      ? input.threshold
      : AUTO_THRESHOLD
  return { expensive, threshold, allowInherit: strings(input.allowInherit) }
}

const key = (ref: ModelRef): string => `${ref.providerID}/${ref.id}`

const label = (ref: ModelRef): string => (ref.variant === undefined ? key(ref) : `${key(ref)}#${ref.variant}`)

/** The base-tier input cost of `ref`, when the model list knows it. */
export function inputCost(ref: ModelRef, available: ReadonlyArray<GuardModel>): number | undefined {
  const model = available.find((m) => m.providerID === ref.providerID && m.id === ref.id)
  const costs = model?.cost ?? []
  const base = costs.find((c) => c.tier === undefined) ?? costs[0]
  return typeof base?.input === "number" ? base.input : undefined
}

/** Whether `ref` is in the expensive set. A listed entry with a variant matches only that variant. */
export function isExpensive(ref: ModelRef, guard: GuardOptions, available: ReadonlyArray<GuardModel>): boolean {
  if (guard.expensive === "auto") {
    const cost = inputCost(ref, available)
    return cost !== undefined && cost >= guard.threshold
  }
  return guard.expensive.some((entry) => {
    const candidate = parseCandidate(entry)
    if (candidate?.kind !== "model") return false
    if (key(candidate.ref) !== key(ref)) return false
    return candidate.ref.variant === undefined || candidate.ref.variant === ref.variant
  })
}

/** The model an agent runs on without inheriting: its own, or the one its role resolves to. */
export function pinnedModel(
  agent: GuardAgent,
  facts: Pick<GuardFacts, "options" | "available" | "health">,
): ModelRef | undefined {
  if (agent.model !== undefined) return agent.model
  const role = roleOf(agent, facts.options.agents)
  if (role === undefined) return undefined
  return resolveRole(facts.options.roles, facts.available, role, facts.health).model
}

/** Spawnable agents and roles that run on a model outside the expensive set. */
export function cheaperAlternatives(facts: GuardFacts): { roleAgents: string[]; agents: string[]; roles: string[] } {
  const roleAgentIds = new Set(facts.roleAgents ?? [])
  const roleAgents: string[] = []
  const agents: string[] = []
  for (const agent of facts.agents) {
    if (agent.id === facts.target || agent.mode === "primary" || agent.hidden === true) continue
    const model = pinnedModel(agent, facts)
    if (model === undefined || isExpensive(model, facts.guard, facts.available)) continue
    if (roleAgentIds.has(agent.id)) {
      roleAgents.push(`${agent.id} (${label(model)})`)
      continue
    }
    const description = agent.description?.trim().split("\n")[0]
    agents.push(description ? `${agent.id} (${label(model)}: ${description})` : `${agent.id} (${label(model)})`)
  }
  const roles: string[] = []
  for (const role of Object.keys(facts.options.roles).sort()) {
    const model = resolveRole(facts.options.roles, facts.available, role, facts.health).model
    if (model !== undefined && !isExpensive(model, facts.guard, facts.available)) roles.push(`${role} → ${label(model)}`)
  }
  return {
    roleAgents: roleAgents.sort(),
    agents: agents.sort().slice(0, CATALOG_LIMIT),
    roles: roles.slice(0, CATALOG_LIMIT),
  }
}

/** Judge one spawn. Anything the guard cannot establish allows. */
export function judgeSpawn(facts: GuardFacts): GuardDecision {
  if (facts.guard.allowInherit.includes(facts.target)) return { allow: true }
  const target = facts.agents.find((agent) => agent.id === facts.target)
  if (target === undefined) return { allow: true }
  if (pinnedModel(target, facts) !== undefined) return { allow: true }
  if (facts.sessionModel === undefined) return { allow: true }
  if (!isExpensive(facts.sessionModel, facts.guard, facts.available)) return { allow: true }

  const { roleAgents, agents, roles } = cheaperAlternatives(facts)
  const lines = [
    `Subagent '${facts.target}' has no model and no resolvable role, so it would inherit this session's expensive model ${label(facts.sessionModel)}.`,
    "Re-issue the spawn with one of:",
  ]
  if (roleAgents.length > 0)
    lines.push(`- a role subagent (general's tools and instructions on a cheaper model role): ${roleAgents.join("; ")}`)
  if (agents.length > 0) lines.push(`- an agent that pins a cheaper model: ${agents.join("; ")}`)
  else if (roleAgents.length === 0) lines.push("- an agent that pins a cheaper model (none is configured)")
  if (roles.length > 0)
    lines.push(
      `- a role for '${facts.target}' in the srobroek.model-roles \`agents\` option (e.g. agents: { "${facts.target}": "<role>" }): ${roles.join("; ")}`,
    )
  lines.push(
    `If '${facts.target}' should run on the session model, add it to the srobroek.model-roles option guard.allowInherit.`,
  )
  return { allow: false, reason: lines.join("\n") }
}
