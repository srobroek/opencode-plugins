/**
 * Tiers for agents that declare none: built-in defaults, and a one-time classification
 * of each subagent from its description by the decider. Pure: the plugin runs the
 * decider through `ctx.generate.text` and caches the answer in `ctx.storage`.
 */

import type { ModelRef } from "./resolve.ts"
import { BUILTIN_AGENT_TIERS, GENERAL_TIER, type TierMeta } from "./tiers.ts"

/** Storage key prefix for an agent's classification. */
export const CLASSIFY_KEY_PREFIX = "classify:"

/** The tier an agent gets when the decider cannot classify it. */
export const CLASSIFY_FALLBACK = "standard"

/** How long one classification may take; it runs in the background, so it gets longer than a spawn's decider. */
export const CLASSIFY_TIMEOUT_MS = 30_000

/** The agent whose tier the per-spawn auto picker chooses, when `auto` is on. */
export const AUTO_AGENT = "general"

export type ClassifyAgent = {
  id: string
  model?: ModelRef
  mode?: string
  description?: string
  request?: { headers?: Readonly<Record<string, string>> }
}

/** A cached classification: the tier, for the description with this hash. */
export type Classification = { hash: string; tier: string }

/** FNV-1a over the text, as 8 hex digits. Stable across runs and hosts. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** The hash an agent's classification is keyed by. */
export const agentHash = (agent: Pick<ClassifyAgent, "description">): string => textHash((agent.description ?? "").trim())

const hasHeader = (agent: ClassifyAgent, header: string): boolean =>
  Object.entries(agent.request?.headers ?? {}).some(([name, value]) => name.toLowerCase() === header && value.trim() !== "")

export type ImplicitPlan = {
  /** Agent id to tier for agents with no model and no tier of their own. */
  implicit: Record<string, string>
  /** Subagents that still need a classification for their current description. */
  pending: ClassifyAgent[]
}

/**
 * Tiers for agents that pin no model and declare no tier (neither in the `agents`
 * option nor the header). `general` gets the standard tier unless the auto picker
 * chooses per spawn; built-ins get their defaults; other subagents get their cached
 * classification when it matches their description, else they are pending and
 * `failed` ones fall back to standard for this run.
 */
export function planImplicit(input: {
  agents: ReadonlyArray<ClassifyAgent>
  configured: Readonly<Record<string, string>>
  header: string
  classified: Readonly<Record<string, Classification>>
  failed?: ReadonlySet<string>
  autoGeneral: boolean
}): ImplicitPlan {
  const implicit: Record<string, string> = {}
  const pending: ClassifyAgent[] = []
  for (const agent of input.agents) {
    if (agent.model !== undefined || Object.hasOwn(input.configured, agent.id) || hasHeader(agent, input.header)) continue
    if (agent.id === AUTO_AGENT) {
      if (!input.autoGeneral) implicit[agent.id] = GENERAL_TIER
      continue
    }
    const builtin = BUILTIN_AGENT_TIERS[agent.id]
    if (builtin !== undefined) {
      implicit[agent.id] = builtin
      continue
    }
    if (agent.mode !== "subagent") continue
    const cached = input.classified[agent.id]
    if (cached !== undefined && cached.hash === agentHash(agent)) implicit[agent.id] = cached.tier
    else if (input.failed?.has(`${agent.id}\0${agentHash(agent)}`)) implicit[agent.id] = CLASSIFY_FALLBACK
    else pending.push(agent)
  }
  return { implicit, pending }
}

/** The classification prompt: the agent's description and each tier's purpose. */
export function buildClassifyPrompt(agent: Pick<ClassifyAgent, "id" | "description">, tiers: Readonly<Record<string, TierMeta>>): string {
  const names = Object.keys(tiers)
  return [
    "You assign a subagent to a model tier once, from its description. Reply with ONLY a JSON object, no prose:",
    `{"tier": "<one of: ${names.join(", ")}>"}`,
    "",
    "Tiers:",
    ...names.map((name) => `- '${name}': ${tiers[name]?.purpose}`),
    "",
    "Pick the cheapest tier that fits the work this agent usually does.",
    "",
    `Agent: ${agent.id}`,
    "Description:",
    "<<<",
    (agent.description ?? "").trim() || "(none)",
    ">>>",
  ].join("\n")
}

/** The tier in the decider's reply: the first JSON object, code fence or not. Anything outside `allowed` is no answer. */
export function parseClassification(text: string, allowed: ReadonlyArray<string>): string | undefined {
  const start = text.indexOf("{")
  const end = text.indexOf("}", start)
  if (start < 0 || end < 0) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { tier?: unknown }
    const tier = typeof value.tier === "string" ? value.tier.trim() : ""
    return allowed.includes(tier) ? tier : undefined
  } catch {
    return undefined
  }
}

/** Read a stored classification; anything malformed is none. */
export function readClassification(value: unknown): Classification | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { hash, tier } = value as { hash?: unknown; tier?: unknown }
  return typeof hash === "string" && typeof tier === "string" ? { hash, tier } : undefined
}
