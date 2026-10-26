/**
 * Pure role resolution for `srobroek.model-roles`. Nothing here touches the
 * plugin context, so every rule is tested directly.
 */

/** Agent request header that names the agent's role. */
export const ROLE_HEADER = "x-opencode-model-role"

/** A model reference in the shape `Agent.Info.model` uses. */
export type ModelRef = { providerID: string; id: string; variant?: string }

/** The part of `Model.Info` resolution needs. */
export type AvailableModel = {
  providerID: string
  id: string
  variants?: ReadonlyArray<{ id: string }>
  enabled?: boolean
}

/** The part of `Agent.Info` resolution needs. */
export type AgentLike = {
  id: string
  model?: ModelRef
  request?: { headers?: Readonly<Record<string, string>> }
}

export type Options = {
  roles: Record<string, string[]>
  agents: Record<string, string>
  fallback: "keep"
}

export type Candidate = { kind: "model"; ref: ModelRef } | { kind: "role"; role: string }

export type Resolution =
  | { model: ModelRef; via: string[]; unhealthy?: true }
  | { model: undefined; reason: "unknown-role" | "unavailable" }

/** When a model last failed, if it is still cooling down; `undefined` when it is healthy. */
export type HealthView = (ref: ModelRef) => number | undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Normalise raw plugin options, dropping anything malformed. */
export function parseOptions(raw: unknown): Options {
  const input = isRecord(raw) ? raw : {}
  const roles: Record<string, string[]> = {}
  if (isRecord(input.roles)) {
    for (const [role, value] of Object.entries(input.roles)) {
      const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : []
      roles[role] = list.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    }
  }
  const agents: Record<string, string> = {}
  if (isRecord(input.agents)) {
    for (const [agent, role] of Object.entries(input.agents)) {
      if (typeof role === "string" && role.trim() !== "") agents[agent] = role.trim()
    }
  }
  return { roles, agents, fallback: "keep" }
}

/** Parse `provider/model#variant` or `@role`. Returns undefined for anything else. */
export function parseCandidate(input: string): Candidate | undefined {
  const text = input.trim()
  if (text.startsWith("@")) {
    const role = text.slice(1).trim()
    return role === "" ? undefined : { kind: "role", role }
  }
  const slash = text.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = text.slice(0, slash)
  const rest = text.slice(slash + 1)
  const hash = rest.lastIndexOf("#")
  const id = hash < 0 ? rest : rest.slice(0, hash)
  const variant = hash < 0 ? undefined : rest.slice(hash + 1)
  if (id === "" || variant === "") return undefined
  return { kind: "model", ref: variant === undefined ? { providerID, id } : { providerID, id, variant } }
}

/** Whether `ref` names an enabled available model and, if it has one, an existing variant. */
export function isAvailable(ref: ModelRef, available: ReadonlyArray<AvailableModel>): boolean {
  const model = available.find((m) => m.providerID === ref.providerID && m.id === ref.id && m.enabled !== false)
  if (model === undefined) return false
  if (ref.variant === undefined) return true
  return (model.variants ?? []).some((v) => v.id === ref.variant)
}

/**
 * Resolve a role to its first available, healthy candidate, following `@role` links
 * depth-first. A link back into the current chain is skipped, as is a link to an
 * unknown role. When every available candidate is unhealthy, the one that failed
 * longest ago wins, so a role never resolves to nothing just because of a cooldown.
 */
export function resolveRole(
  roles: Readonly<Record<string, ReadonlyArray<string>>>,
  available: ReadonlyArray<AvailableModel>,
  role: string,
  health: HealthView = () => undefined,
): Resolution {
  if (!Object.hasOwn(roles, role)) return { model: undefined, reason: "unknown-role" }
  let stale: { model: ModelRef; via: string[]; failedAt: number } | undefined
  const walk = (current: string, chain: string[]): { model: ModelRef; via: string[] } | undefined => {
    for (const entry of roles[current] ?? []) {
      const candidate = parseCandidate(entry)
      if (candidate === undefined) continue
      if (candidate.kind === "model") {
        if (!isAvailable(candidate.ref, available)) continue
        const failedAt = health(candidate.ref)
        if (failedAt === undefined) return { model: candidate.ref, via: chain }
        if (stale === undefined || failedAt < stale.failedAt) stale = { model: candidate.ref, via: chain, failedAt }
        continue
      }
      if (chain.includes(candidate.role) || !Object.hasOwn(roles, candidate.role)) continue
      const found = walk(candidate.role, [...chain, candidate.role])
      if (found) return found
    }
    return undefined
  }
  const found = walk(role, [role])
  if (found) return found
  if (stale) return { model: stale.model, via: stale.via, unhealthy: true }
  return { model: undefined, reason: "unavailable" }
}

/** The role an agent declares: plugin options win over the request header. */
export function roleOf(agent: AgentLike, agents: Readonly<Record<string, string>>): string | undefined {
  if (Object.hasOwn(agents, agent.id)) return agents[agent.id]
  const headers = agent.request?.headers ?? {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === ROLE_HEADER && value.trim() !== "") return value.trim()
  }
  return undefined
}

/**
 * The model each role-bearing agent should get. Agents whose role is unknown or
 * has nothing available are absent, so their own model (or inheritance) stays.
 */
export function desiredModels(
  agents: ReadonlyArray<AgentLike>,
  options: Options,
  available: ReadonlyArray<AvailableModel>,
  health?: HealthView,
): Map<string, ModelRef> {
  const result = new Map<string, ModelRef>()
  for (const agent of agents) {
    const role = roleOf(agent, options.agents)
    if (role === undefined) continue
    const resolution = resolveRole(options.roles, available, role, health)
    if (resolution.model) result.set(agent.id, resolution.model)
  }
  return result
}

/** The variant the host reports when none was chosen; labels leave it out. */
export const DEFAULT_VARIANT = "default"

/** `provider/model#variant` for notes and messages, without the host's `#default`. */
export function modelText(ref: ModelRef): string {
  const variant = ref.variant === undefined || ref.variant === DEFAULT_VARIANT ? "" : `#${ref.variant}`
  return `${ref.providerID}/${ref.id}${variant}`
}

/** Field-wise model comparison; key order and an absent vs undefined variant do not matter. */
export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? undefined) === (b.variant ?? undefined)
}

/** Ids of agents whose current model differs from the one their role resolves to. */
export function staleAgents(agents: ReadonlyArray<AgentLike>, desired: ReadonlyMap<string, ModelRef>): string[] {
  return agents.filter((a) => desired.has(a.id) && !sameModel(a.model, desired.get(a.id))).map((a) => a.id)
}

/** Remove the role header (any casing) from outgoing request headers. Returns whether one was removed. */
export function stripRoleHeader(headers: Record<string, string>): boolean {
  let removed = false
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === ROLE_HEADER) {
      delete headers[name]
      removed = true
    }
  }
  return removed
}
