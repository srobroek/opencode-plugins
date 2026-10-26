/**
 * Role subagents (`general-<role>`) and the runtime options for `srobroek.model-roles`.
 * Pure: the plugin applies `shapeRoleAgent` inside its agent transform.
 */

import { DEFAULT_COOLDOWN_MS } from "./health.ts"
import { type ModelRef, type Options, ROLE_HEADER } from "./resolve.ts"

export const DEFAULT_ROLE_AGENTS = ["smol", "task", "slow", "challenger"] as const

export const ROLE_AGENT_PREFIX = "general-"

/** When the parent should pick each well-known role. */
export const ROLE_PURPOSE: Readonly<Record<string, string>> = {
  smol: "cheap and fast: lookups, summaries, log and diff reading, mechanical edits",
  task: "everyday implementation and investigation",
  slow: "hard reasoning: design, root-cause debugging, subtle concurrency or data-integrity work",
  challenger: "an independent second opinion or review from a different model",
}

export type RuntimeOptions = {
  cooldownMs: number
  retryOnFallback: boolean
  /** Roles that get a `general-<role>` subagent. */
  roleAgents: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Normalise the fallback and role-agent options. `roleAgents` keeps only configured roles. */
export function parseRuntime(raw: unknown, options: Options): RuntimeOptions {
  const input = isRecord(raw) ? raw : {}
  const cooldownMs =
    typeof input.cooldownMs === "number" && Number.isFinite(input.cooldownMs) && input.cooldownMs >= 0
      ? input.cooldownMs
      : DEFAULT_COOLDOWN_MS
  const wanted = Array.isArray(input.roleAgents)
    ? input.roleAgents.filter((role): role is string => typeof role === "string")
    : [...DEFAULT_ROLE_AGENTS]
  const roleAgents = [...new Set(wanted.map((role) => role.trim()))].filter((role) => Object.hasOwn(options.roles, role))
  return { cooldownMs, retryOnFallback: input.retryOnFallback !== false, roleAgents }
}

export const roleAgentId = (role: string): string => `${ROLE_AGENT_PREFIX}${role}`

/** A short cost label from an input price in USD per million tokens. */
export function costTier(input: number | undefined): string {
  if (input === undefined) return "cost unknown"
  const tier = input < 1 ? "low cost" : input < 4 ? "medium cost" : "high cost"
  return `${tier}, $${input}/M input tokens`
}

export function roleAgentDescription(role: string, model: ModelRef | undefined, inputCost: number | undefined): string {
  const purpose = ROLE_PURPOSE[role] ?? `work that suits the '${role}' model role`
  const runs =
    model === undefined
      ? "no model of this role is available now, so it inherits yours"
      : `runs ${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""} (${costTier(inputCost)})`
  return `General-purpose agent on the '${role}' model role: ${purpose}. It ${runs}. Same tools and instructions as general.`
}

/** The parts of an agent a role subagent takes from `general`. */
export type CloneableAgent = {
  name?: string
  description?: string
  mode?: string
  hidden?: boolean
  system?: string
  steps?: number
  permissions?: unknown[]
  request?: { headers?: Record<string, string> }
}

/**
 * Shape `draft` (the agent `general-<role>`) after `general`. Fields the user set on
 * the same id win, except the role header, which is the point of the agent. A
 * `created` agent gets mode `subagent`, since the host fills new agents with `primary`.
 */
export function shapeRoleAgent(
  draft: CloneableAgent,
  general: CloneableAgent | undefined,
  role: string,
  description: string,
  created: boolean,
): void {
  draft.name = created || draft.name === undefined ? roleAgentId(role) : draft.name
  if (created || draft.description === undefined) draft.description = description
  if (created || draft.mode === undefined) draft.mode = "subagent"
  if (created) draft.hidden = false
  if (draft.system === undefined && general?.system !== undefined) draft.system = general.system
  if (draft.steps === undefined && general?.steps !== undefined) draft.steps = general.steps
  draft.permissions = [...structuredClone(general?.permissions ?? []), ...(created ? [] : (draft.permissions ?? []))]
  draft.request = { ...draft.request, headers: { ...draft.request?.headers, [ROLE_HEADER]: role } }
}
