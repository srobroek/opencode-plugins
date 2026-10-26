/**
 * The model-roles contract shared by every plugin that ships agents. An agent names its
 * role in this request header; the model-roles plugin resolves the role to a model and
 * strips the header before any request reaches a provider. Without that plugin the
 * header is ignored and the agent keeps its own model, or inherits the session's.
 */

export const MODEL_ROLE_HEADER = "x-opencode-model-role"

/** The roles a shipped agent may declare; they match the user's model-roles role map. */
export const MODEL_ROLES = [
  "default",
  "task",
  "slow",
  "smol",
  "tiny",
  "commit",
  "reviewer",
  "challenger",
  "architect",
  "designer",
  "plan",
  "judge",
] as const

export type ModelRole = (typeof MODEL_ROLES)[number]

export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (MODEL_ROLES as readonly string[]).includes(value)
}

/** The role an agent's request headers declare, if any. */
export function agentRole(request: { headers?: Record<string, string> } | undefined): string | undefined {
  return request?.headers?.[MODEL_ROLE_HEADER]
}
