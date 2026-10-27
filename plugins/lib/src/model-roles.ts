/**
 * The model-roles contract shared by every plugin that ships agents. An agent names its
 * model tier in this request header; the model-roles plugin resolves the tier to a model
 * and strips the header before any request reaches a provider. Without that plugin the
 * header is ignored and the agent keeps its own model, or inherits the session's.
 */

export const MODEL_ROLE_HEADER = "x-opencode-model-role"

/** The built-in tiers a shipped agent declares. */
export const MODEL_TIERS = ["cheap", "standard", "strong", "reviewer"] as const

export type ModelTier = (typeof MODEL_TIERS)[number]

/** Old role names model-roles still accepts, and the tier each stands for. `default` means inherit. */
export const MODEL_TIER_ALIASES: Readonly<Record<string, ModelTier | "inherit">> = {
  default: "inherit",
  smol: "cheap",
  commit: "cheap",
  tiny: "cheap",
  task: "standard",
  slow: "strong",
  plan: "strong",
  architect: "strong",
  designer: "strong",
  challenger: "reviewer",
  judge: "reviewer",
}

/** Every value the header may carry: the tiers, then the accepted aliases (kept literal so bundles can drop it). */
export const MODEL_ROLES: ReadonlyArray<string> = [
  "cheap",
  "standard",
  "strong",
  "reviewer",
  "default",
  "smol",
  "commit",
  "tiny",
  "task",
  "slow",
  "plan",
  "architect",
  "designer",
  "challenger",
  "judge",
]

export type ModelRole = string

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value)
}

/** A tier or an accepted alias. */
export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && MODEL_ROLES.includes(value)
}

/** The tier a header value stands for: the tier itself, an alias's tier, or `undefined`. */
export function tierFor(value: string): ModelTier | "inherit" | undefined {
  return isModelTier(value) ? value : MODEL_TIER_ALIASES[value]
}

/** The tier an agent's request headers declare, if any. */
export function agentRole(request: { headers?: Record<string, string> } | undefined): string | undefined {
  return request?.headers?.[MODEL_ROLE_HEADER]
}
