/**
 * The optional auto decider for `srobroek.model-roles`: a small model picks a role
 * for a fresh `subagent` spawn that names no model and no role and whose agent has
 * neither. Pure: the plugin calls `ctx.generate.text` with `buildDeciderPrompt` and
 * applies `parseDecision`, `pickRole` and `capRole` in its `execute.before` hook.
 */

import { type GuardAgent, type GuardModel, inputCost } from "./guard.ts"
import {
  type HealthView,
  type ModelRef,
  modelText,
  type Options,
  parseCandidate,
  resolveRole,
  roleOf,
} from "./resolve.ts"
import { describeChoice, type RoleChoice } from "./spawn-role.ts"

/** How long a spawn waits for the decider before it takes the default role. */
export const DEFAULT_AUTO_TIMEOUT_MS = 5000

/** The longest slice of the spawn prompt the decider sees. */
export const DECIDER_PROMPT_LIMIT = 6000

/** Auto decisions `model_roles_check` lists, newest first. */
export const AUTO_HISTORY_LIMIT = 20

export const DEFAULT_AUTO_ROLES: ReadonlyArray<string> = ["smol", "task"]

export type AutoOptions = {
  /** `@role` or `provider/model#variant` the decider runs on. */
  decider: string
  /** Roles the decider may pick, in configured order. */
  roles: string[]
  /** The role a spawn gets when the decider is unsure, slow, unavailable or wrong. */
  default: string
  timeoutMs: number
  /** Never pick a role whose model costs more than the calling session's model. */
  capAtParent: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Normalise the `auto` option. `undefined` means auto routing is off. `true` means
 * the defaults. Allowed roles keep only configured ones; with none left it is off.
 */
export function parseAuto(raw: unknown, options: Options): AutoOptions | undefined {
  if (raw === undefined || raw === false || raw === null) return undefined
  const input = isRecord(raw) ? raw : {}
  if (input.enabled === false) return undefined
  const listed = Array.isArray(input.roles)
    ? input.roles.filter((r): r is string => typeof r === "string").map((r) => r.trim())
    : [...DEFAULT_AUTO_ROLES]
  const roles = [...new Set(listed)].filter((role) => role !== "" && Object.hasOwn(options.roles, role))
  if (roles.length === 0) return undefined
  const wanted = typeof input.default === "string" ? input.default.trim() : ""
  const fallback = roles.includes(wanted) ? wanted : roles.includes("task") ? "task" : (roles[0] as string)
  const decider = typeof input.decider === "string" && input.decider.trim() !== "" ? input.decider.trim() : "@smol"
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_AUTO_TIMEOUT_MS
  return { decider, roles, default: fallback, timeoutMs, capAtParent: input.capAtParent !== false }
}

/** The model the decider runs on, or `undefined` when nothing is available for it. */
export function deciderModel(
  auto: AutoOptions,
  options: Options,
  available: ReadonlyArray<GuardModel>,
  health?: HealthView,
): ModelRef | undefined {
  const candidate = parseCandidate(auto.decider)
  if (candidate === undefined) return undefined
  if (candidate.kind === "role") return resolveRole(options.roles, available, candidate.role, health).model
  const listed = available.some(
    (m) => m.providerID === candidate.ref.providerID && m.id === candidate.ref.id && m.enabled !== false,
  )
  return listed ? candidate.ref : undefined
}

/**
 * Whether auto routing may pick a role for this spawn. Never when the spawn resumes
 * a session, names a model or a role, or its agent has a model or a role of its own.
 */
export function autoEligible(input: unknown, agent: GuardAgent | undefined, options: Options): boolean {
  if (!isRecord(input) || agent === undefined) return false
  if (typeof input.sessionID === "string" && input.sessionID !== "") return false
  if (typeof input.model === "string" && input.model.trim() !== "") return false
  if (typeof input.role === "string" && input.role.trim() !== "") return false
  if (agent.model !== undefined) return false
  return roleOf(agent, options.agents) === undefined
}

export type DeciderInput = {
  agent: { id: string; description?: string }
  /** The spawn's short label. */
  description?: string
  prompt: string
  /** The roles the decider may pick, with purpose and cost tier. */
  choices: ReadonlyArray<RoleChoice>
}

/** The decider prompt. The spawn prompt is cut to `DECIDER_PROMPT_LIMIT` characters. */
export function buildDeciderPrompt(input: DeciderInput): string {
  const task =
    input.prompt.length > DECIDER_PROMPT_LIMIT ? `${input.prompt.slice(0, DECIDER_PROMPT_LIMIT)}\n[truncated]` : input.prompt
  const names = input.choices.map((choice) => choice.role).join(", ")
  const agent = input.agent.description?.trim()
  return [
    "You route a subagent task to a model role. Reply with ONLY a JSON object, no prose:",
    `{"role": "<one of: ${names}>", "confident": true|false}`,
    "",
    "Roles:",
    ...input.choices.map((choice) => `- ${describeChoice(choice)}`),
    "",
    "Pick the cheapest role that fits the task. Set confident to false when the task is ambiguous.",
    "",
    `Agent: ${input.agent.id}${agent ? ` — ${agent}` : ""}`,
    `Spawn description: ${input.description?.trim() || "(none)"}`,
    "Task:",
    "<<<",
    task,
    ">>>",
  ].join("\n")
}

export type Decision = { role: string; confident: boolean }

/**
 * Read the decider's reply: the first JSON object in it, code fence or not. A role
 * outside `allowed` or a missing `confident` flag is no decision.
 */
export function parseDecision(text: string, allowed: ReadonlyArray<string>): Decision | undefined {
  const start = text.indexOf("{")
  const end = text.indexOf("}", start)
  if (start < 0 || end < 0) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.confident !== "boolean") return undefined
  const role = value.role.trim()
  return allowed.includes(role) ? { role, confident: value.confident } : undefined
}

export type AutoReason = "confident" | "unsure" | "invalid" | "timeout" | "error" | "no-decider"

/** The decided role, or the default with the reason the decision was not taken. */
export function pickRole(
  decision: Decision | undefined,
  auto: Pick<AutoOptions, "default">,
  failure?: Exclude<AutoReason, "confident" | "unsure" | "invalid">,
): { role: string; reason: AutoReason } {
  if (failure !== undefined) return { role: auto.default, reason: failure }
  if (decision === undefined) return { role: auto.default, reason: "invalid" }
  if (!decision.confident) return { role: auto.default, reason: "unsure" }
  return { role: decision.role, reason: "confident" }
}

export type RoleCost = { role: string; cost: number | undefined }

/**
 * Keep `role` unless its model costs more than the parent's: then the dearest allowed
 * role at or under the parent's cost, else the cheapest allowed role. Unknown costs
 * leave the role alone.
 */
export function capRole(role: string, costs: ReadonlyArray<RoleCost>, parentCost: number | undefined): string {
  const chosen = costs.find((entry) => entry.role === role)?.cost
  if (parentCost === undefined || chosen === undefined || chosen <= parentCost) return role
  const known = costs.filter((entry): entry is { role: string; cost: number } => entry.cost !== undefined)
  const under = known.filter((entry) => entry.cost <= parentCost).sort((a, b) => b.cost - a.cost)[0]
  if (under !== undefined) return under.role
  return known.sort((a, b) => a.cost - b.cost)[0]?.role ?? role
}

/** The input cost of the model each role resolves to right now. */
export function roleCosts(
  roles: ReadonlyArray<string>,
  options: Options,
  available: ReadonlyArray<GuardModel>,
  health?: HealthView,
): RoleCost[] {
  return roles.map((role) => {
    const model = resolveRole(options.roles, available, role, health).model
    return { role, cost: model === undefined ? undefined : inputCost(model, available) }
  })
}

export type AutoRecord = {
  at: number
  agent: string
  role: string
  reason: AutoReason
  /** The role the decider picked before `capAtParent` stepped it down. */
  capped?: string
  model?: ModelRef
  ms: number
}

/** A short tag for the spawn description, so the choice shows in the session title. */
export function autoTag(record: Pick<AutoRecord, "role" | "reason" | "capped">): string {
  const why = record.capped !== undefined ? `capped from ${record.capped}` : record.reason
  return `[auto: ${record.role}, ${why}]`
}

/** The spawn description with the auto tag appended. */
export function withAutoTag(description: unknown, record: Pick<AutoRecord, "role" | "reason" | "capped">): string {
  const text = typeof description === "string" ? description.trim() : ""
  return text === "" ? autoTag(record) : `${text} ${autoTag(record)}`
}

/** `history` with `record` in front, at most `AUTO_HISTORY_LIMIT` long. */
export function pushHistory(history: ReadonlyArray<AutoRecord>, record: AutoRecord): AutoRecord[] {
  return [record, ...history].slice(0, AUTO_HISTORY_LIMIT)
}

/** The auto history as lines for `model_roles_check`. */
export function formatHistory(history: ReadonlyArray<AutoRecord>): string[] {
  if (history.length === 0) return []
  return [
    "",
    "Recent auto routing (newest first):",
    ...history.map((r) => {
      const model = r.model === undefined ? "no model available; agent default" : modelText(r.model)
      const why = r.capped !== undefined ? `${r.reason}, capped from ${r.capped}` : r.reason
      return `  - ${new Date(r.at).toISOString()} ${r.agent} → ${r.role} (${model}; ${why}; ${r.ms} ms)`
    }),
  ]
}
