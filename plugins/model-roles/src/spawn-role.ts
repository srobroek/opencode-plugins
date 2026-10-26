/**
 * The `role` parameter on the built-in `subagent` tool, and the runtime options for
 * `srobroek.model-roles`. Pure: the plugin applies these inside its tool transform
 * and its `execute.before` hook.
 */

import { type GuardModel, inputCost } from "./guard.ts"
import { DEFAULT_COOLDOWN_MS } from "./health.ts"
import {
  type AvailableModel,
  type HealthView,
  isAvailable,
  type ModelRef,
  type Options,
  parseCandidate,
  resolveRole,
} from "./resolve.ts"

export const ROLE_PARAM = "role"

/** When the parent should pick each well-known role. */
export const ROLE_PURPOSE: Readonly<Record<string, string>> = {
  smol: "cheap and fast: lookups, summaries, log and diff reading, mechanical edits",
  task: "everyday implementation and investigation",
  slow: "hard reasoning: design, root-cause debugging, subtle concurrency or data-integrity work",
  challenger: "an independent second opinion or review from a different model",
}

/** Appended to the `subagent` tool description when the `role` parameter is offered. */
export const ROLE_TOOL_NOTE =
  "Set `role` on every new spawn: it picks the model the subagent runs on. Choose the cheapest role that fits the task. An explicit `model` overrides it; a resumed spawn (`sessionID`) keeps its model."

export type RuntimeOptions = {
  cooldownMs: number
  retryOnFallback: boolean
  /** Your own purpose text per role, shown to the spawner. */
  purposes: Record<string, string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Normalise the fallback options and the role purposes. Purposes keep only configured roles. */
export function parseRuntime(raw: unknown, options: Options): RuntimeOptions {
  const input = isRecord(raw) ? raw : {}
  const cooldownMs =
    typeof input.cooldownMs === "number" && Number.isFinite(input.cooldownMs) && input.cooldownMs >= 0
      ? input.cooldownMs
      : DEFAULT_COOLDOWN_MS
  const purposes: Record<string, string> = {}
  if (isRecord(input.purposes)) {
    for (const [role, text] of Object.entries(input.purposes)) {
      if (typeof text === "string" && text.trim() !== "" && Object.hasOwn(options.roles, role)) purposes[role] = text.trim()
    }
  }
  return { cooldownMs, retryOnFallback: input.retryOnFallback !== false, purposes }
}

/** A short cost label from an input price in USD per million tokens. */
export function costTier(input: number | undefined): string {
  if (input === undefined) return "cost unknown"
  const tier = input < 1 ? "low cost" : input < 4 ? "medium cost" : "high cost"
  return `${tier}, $${input}/M input tokens`
}

/**
 * The lowest input cost among a role's available candidates, following `@role` links.
 * Health is ignored, so the figure only moves when availability does.
 */
export function cheapestCost(
  roles: Options["roles"],
  available: ReadonlyArray<GuardModel>,
  role: string,
): number | undefined {
  let cheapest: number | undefined
  const seen = new Set<string>()
  const walk = (current: string) => {
    if (seen.has(current) || !Object.hasOwn(roles, current)) return
    seen.add(current)
    for (const entry of roles[current] ?? []) {
      const candidate = parseCandidate(entry)
      if (candidate === undefined) continue
      if (candidate.kind === "role") {
        walk(candidate.role)
        continue
      }
      if (!isAvailable(candidate.ref, available)) continue
      const cost = inputCost(candidate.ref, available)
      if (cost !== undefined && (cheapest === undefined || cost < cheapest)) cheapest = cost
    }
  }
  walk(role)
  return cheapest
}

export type RoleChoice = { role: string; purpose: string; cost: number | undefined; available: boolean }

/** The roles a spawner may pass, in name order, with their purpose and cost tier. */
export function roleChoices(
  options: Options,
  available: ReadonlyArray<GuardModel>,
  purposes: Readonly<Record<string, string>> = {},
): RoleChoice[] {
  return Object.keys(options.roles)
    .sort()
    .map((role) => ({
      role,
      purpose: purposes[role] ?? ROLE_PURPOSE[role] ?? `work that suits the '${role}' model role`,
      cost: cheapestCost(options.roles, available, role),
      available: resolveRole(options.roles, available, role).model !== undefined,
    }))
}

export function describeChoice(choice: RoleChoice): string {
  const tier = choice.available ? costTier(choice.cost) : "no model available now; the agent's own model applies"
  return `'${choice.role}': ${choice.purpose} (${tier})`
}

/** The `role` parameter's description: one line per role. */
export function roleParamDescription(choices: ReadonlyArray<RoleChoice>): string {
  return [
    "Model role the subagent runs on. Pick the cheapest one that fits the task:",
    ...choices.map((choice) => `- ${describeChoice(choice)}`),
  ].join("\n")
}

export type JsonObjectSchema = {
  type: "object"
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties?: boolean
}

const JSON_TYPES: Readonly<Record<string, string>> = { String: "string", Boolean: "boolean", Number: "number" }

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The `subagent` tool's input as JSON Schema. Accepts a JSON Schema object as is, or
 * reads an Effect struct's AST of plain strings, booleans and numbers. Anything else
 * returns `undefined`, so the caller leaves the schema alone.
 */
export function toJsonSchema(input: unknown): JsonObjectSchema | undefined {
  if (isRecord(input) && input.type === "object" && isRecord(input.properties))
    return structuredClone(input) as JsonObjectSchema
  const ast = (input as { ast?: unknown } | null | undefined)?.ast
  if (!isRecord(ast) || ast._tag !== "Objects" || !Array.isArray(ast.propertySignatures)) return undefined
  if (Array.isArray(ast.indexSignatures) && ast.indexSignatures.length > 0) return undefined
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const signature of ast.propertySignatures as unknown[]) {
    if (!isRecord(signature) || typeof signature.name !== "string" || !isRecord(signature.type)) return undefined
    const type = signature.type
    const json = typeof type._tag === "string" ? JSON_TYPES[type._tag] : undefined
    if (json === undefined) return undefined
    const property: Record<string, unknown> = { type: json }
    let description = isRecord(type.annotations) && typeof type.annotations.description === "string" ? type.annotations.description : undefined
    for (const check of Array.isArray(type.checks) ? type.checks : []) {
      const annotations = isRecord(check) && isRecord(check.annotations) ? check.annotations : {}
      if (typeof annotations.description === "string") description ??= annotations.description
      const representation = isRecord(annotations.representation) ? annotations.representation : {}
      const payload = isRecord(representation.payload) ? representation.payload : {}
      if (representation.id === "effect/schema/isStartingWith" && typeof payload.startsWith === "string")
        property.pattern = `^${escapeRegExp(payload.startsWith)}`
    }
    if (description !== undefined) property.description = description
    properties[signature.name] = property
    const optional = isRecord(type.context) && type.context.isOptional === true
    if (!optional) required.push(signature.name)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

/** `schema` with an optional `role` enum over `roles`. */
export function withRoleParam(schema: JsonObjectSchema, roles: ReadonlyArray<string>, description: string): JsonObjectSchema {
  const next = structuredClone(schema)
  next.properties[ROLE_PARAM] = { type: "string", enum: [...roles], description }
  next.required = (next.required ?? []).filter((name) => name !== ROLE_PARAM)
  return next
}

/** The tool description with the role note appended once. */
export function withRoleNote(description: string): string {
  return description.includes(ROLE_TOOL_NOTE) ? description : `${description.trimEnd()}\n${ROLE_TOOL_NOTE}`
}

export const modelLabel = (ref: ModelRef): string => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

export type SpawnPlan = {
  /** The input the tool runs with: `role` removed, `model` set when the role resolved. */
  input: unknown
  /** The role the spawner passed, when it applies. */
  role?: string
  /** The model the role resolved to. */
  model?: ModelRef
  /** Set when the role is not configured; the spawn should be refused with it. */
  error?: string
}

/**
 * Apply the `role` argument of one `subagent` call. Precedence: an explicit `model`,
 * then `role`, then whatever the agent itself resolves to (its role in the `agents`
 * option or header, its own model, or inheritance), which the host applies.
 */
export function planSpawn(
  input: unknown,
  options: Options,
  available: ReadonlyArray<AvailableModel>,
  health?: HealthView,
): SpawnPlan {
  if (!isRecord(input) || !Object.hasOwn(input, ROLE_PARAM)) return { input }
  const { [ROLE_PARAM]: raw, ...rest } = input
  const role = typeof raw === "string" ? raw.trim() : ""
  if (role === "") return { input: rest }
  if (typeof rest.sessionID === "string" && rest.sessionID !== "") return { input: rest }
  if (typeof rest.model === "string" && rest.model.trim() !== "") return { input: rest }
  if (!Object.hasOwn(options.roles, role)) {
    const known = Object.keys(options.roles).sort()
    return {
      input: rest,
      error: `Unknown model role '${role}'. Pass one of: ${known.join(", ") || "(none configured)"}.`,
    }
  }
  const model = resolveRole(options.roles, available, role, health).model
  if (model === undefined) return { input: rest, role }
  return { input: { ...rest, model: modelLabel(model) }, role, model }
}

/** The model a spawn's `model` argument names, if any. */
export function inputModel(input: unknown): ModelRef | undefined {
  if (!isRecord(input) || typeof input.model !== "string") return undefined
  const candidate = parseCandidate(input.model)
  return candidate?.kind === "model" ? candidate.ref : undefined
}

/** Storage key for the role a child session was spawned with. */
export const SPAWN_ROLE_KEY_PREFIX = "spawn-role:"
