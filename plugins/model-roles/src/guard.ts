/**
 * Pure subagent-model guard for `srobroek.model-roles`: deny a `subagent` spawn
 * whose target agent would silently inherit an expensive session model.
 */

import {
  type AvailableModel,
  type HealthView,
  type ModelRef,
  modelText,
  type Options,
  parseCandidate,
  resolveRole,
  roleOf,
} from "./resolve.ts"

/** Input cost (USD per million tokens) at or above which `"auto"` counts a model as expensive. */
export const AUTO_THRESHOLD = 4

/** How many alternatives a deny message names. */
export const CATALOG_LIMIT = 12

/** How many pinned agents a deny message names when a cheaper role exists. */
export const AGENT_HINT_LIMIT = 5

/** Longest agent summary a deny message quotes. */
export const SUMMARY_LIMIT = 80

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

const label = modelText

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

export type CheapRole = { role: string; model: ModelRef; cost: number | undefined }

export type CheapAgent = { id: string; model: ModelRef; summary?: string }

/** The first sentence of an agent description's first line, capped at `SUMMARY_LIMIT`. */
export function summarize(description: string | undefined): string | undefined {
  const line = description?.trim().split("\n")[0]?.trim() ?? ""
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line
  const text = sentence.replace(/[.!?]$/, "")
  if (text === "") return undefined
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 3).trimEnd()}...` : text
}

const agentText = (agent: CheapAgent, withSummary: boolean): string =>
  withSummary && agent.summary !== undefined
    ? `${agent.id} (${label(agent.model)}: ${agent.summary})`
    : `${agent.id} (${label(agent.model)})`

/** Spawnable agents and roles that run on a model outside the expensive set. Roles come cheapest first. */
export function cheaperAlternatives(facts: GuardFacts): { agents: CheapAgent[]; roles: CheapRole[] } {
  const agents: CheapAgent[] = []
  for (const agent of facts.agents) {
    if (agent.id === facts.target || agent.mode === "primary" || agent.hidden === true) continue
    const model = pinnedModel(agent, facts)
    if (model === undefined || isExpensive(model, facts.guard, facts.available)) continue
    const summary = summarize(agent.description)
    agents.push(summary === undefined ? { id: agent.id, model } : { id: agent.id, model, summary })
  }
  const roles: CheapRole[] = []
  for (const role of Object.keys(facts.options.roles).sort()) {
    const model = resolveRole(facts.options.roles, facts.available, role, facts.health).model
    if (model !== undefined && !isExpensive(model, facts.guard, facts.available))
      roles.push({ role, model, cost: inputCost(model, facts.available) })
  }
  roles.sort((a, b) => (a.cost ?? Number.POSITIVE_INFINITY) - (b.cost ?? Number.POSITIVE_INFINITY))
  agents.sort((a, b) => a.id.localeCompare(b.id))
  return { agents: agents.slice(0, CATALOG_LIMIT), roles: roles.slice(0, CATALOG_LIMIT) }
}

const price = (cost: number | undefined): string => (cost === undefined ? "cost unknown" : `$${cost}/M input tokens`)

/** Judge one spawn. Anything the guard cannot establish allows. */
export function judgeSpawn(facts: GuardFacts): GuardDecision {
  if (facts.guard.allowInherit.includes(facts.target)) return { allow: true }
  const target = facts.agents.find((agent) => agent.id === facts.target)
  if (target === undefined) return { allow: true }
  if (pinnedModel(target, facts) !== undefined) return { allow: true }
  if (facts.sessionModel === undefined) return { allow: true }
  if (!isExpensive(facts.sessionModel, facts.guard, facts.available)) return { allow: true }

  const { agents, roles } = cheaperAlternatives(facts)
  const lines = [
    `Subagent '${facts.target}' has no model and no resolvable role, so it would inherit this session's expensive model ${label(facts.sessionModel)}.`,
  ]
  const [cheapest, ...others] = roles
  if (cheapest !== undefined) {
    lines.push(
      `Re-issue the spawn with role: "${cheapest.role}" (runs ${label(cheapest.model)}, ${price(cheapest.cost)}), or another role that fits the task better.`,
    )
    if (others.length > 0)
      lines.push(`Other cheaper roles: ${others.map((r) => `${r.role} → ${label(r.model)} (${price(r.cost)})`).join("; ")}`)
  } else lines.push("No model role resolves to a cheaper model right now.")
  // With a role to pass, pinned agents are a side note: ids and models only.
  const hinted = cheapest === undefined ? agents : agents.slice(0, AGENT_HINT_LIMIT)
  const more = agents.length > hinted.length ? `; ${agents.length - hinted.length} more` : ""
  if (hinted.length > 0)
    lines.push(
      `Or spawn an agent that pins a cheaper model: ${hinted.map((a) => agentText(a, cheapest === undefined)).join("; ")}${more}`,
    )
  lines.push(
    `If '${facts.target}' should run on the session model, add it to the srobroek.model-roles option guard.allowInherit.`,
  )
  return { allow: false, reason: lines.join("\n") }
}
