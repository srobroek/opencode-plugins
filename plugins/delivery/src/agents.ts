/**
 * The delivery agents, shipped as V2 agent markdown under `agents/` and registered
 * through `ctx.agent.transform`, so installing the plugin is enough to get them.
 *
 * Markdown and config agents load after plugins, so a user's own `implementer.md`
 * still wins field by field. Each agent names its model-roles tier in the
 * `x-opencode-model-role` header. With the model-roles plugin installed, that tier
 * picks the model. Without it, the file's `model` is a fallback, used only when it is
 * available on this machine; otherwise the agent inherits the session's model. A
 * fallback is marked in the `x-opencode-model-fallback` header, so model-roles never
 * mistakes it for a user's pin.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type FallbackOwners, listsPlugin } from "@srobroek/opencode-lib/agent-fallback"
import { MODEL_FALLBACK_HEADER } from "@srobroek/opencode-lib/model-roles"

export const AGENT_IDS = [
  "implementer",
  "implementer-high",
  "researcher",
  "pr-reviewer",
  "operator",
  "shepherd",
] as const
export type AgentId = (typeof AGENT_IDS)[number]

export type ModelRef = { providerID: string; id: string; variant?: string }

export type AgentPermission = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

export type AgentFile = {
  id: string
  description?: string
  mode: string
  model?: string
  request?: { headers?: Record<string, string> }
  permissions: AgentPermission[]
  system: string
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function agentPath(id: string): string {
  return fileURLToPath(new URL(`../agents/${id}.md`, import.meta.url))
}

/** Parse one agent file. Throws on a file without frontmatter. */
export function parseAgentFile(id: string, text: string): AgentFile {
  const match = FRONTMATTER.exec(text)
  if (!match) throw new Error(`agents/${id}.md has no frontmatter`)
  const data = (Bun.YAML.parse(match[1] ?? "") ?? {}) as Record<string, unknown>
  const permissions = Array.isArray(data.permissions) ? (data.permissions as AgentPermission[]) : []
  return {
    id,
    description: typeof data.description === "string" ? data.description : undefined,
    mode: typeof data.mode === "string" ? data.mode : "subagent",
    model: typeof data.model === "string" ? data.model : undefined,
    ...(data.request && typeof data.request === "object" ? { request: data.request as AgentFile["request"] } : {}),
    permissions,
    system: text.slice(match[0].length).trim(),
  }
}

/** `provider/model#variant` as a model reference, or undefined when it names none. */
export function parseModel(value: string): ModelRef | undefined {
  const [path, variant] = value.split("#", 2)
  const slash = path?.indexOf("/") ?? -1
  if (path === undefined || slash <= 0 || slash === path.length - 1) return undefined
  const ref: ModelRef = { providerID: path.slice(0, slash), id: path.slice(slash + 1) }
  if (variant) ref.variant = variant
  return ref
}

export type Available = { providerID: string; id: string; enabled?: boolean; variants?: ReadonlyArray<{ id: string }> }

/** The model ref when it is enabled here (and its variant exists), otherwise undefined. */
export function availableModel(ref: ModelRef | undefined, available: readonly Available[]): ModelRef | undefined {
  if (ref === undefined) return undefined
  const model = available.find((m) => m.providerID === ref.providerID && m.id === ref.id && m.enabled !== false)
  if (model === undefined) return undefined
  if (ref.variant !== undefined && !(model.variants ?? []).some((v) => v.id === ref.variant)) {
    return { providerID: ref.providerID, id: ref.id }
  }
  return ref
}

export type AgentDraft = {
  name?: string
  description?: string
  mode?: string
  model?: unknown
  system?: string
  request?: { headers?: Record<string, string> }
  permissions?: unknown[]
}

/** A model for an agent; `fallback` when it is the file's own, not a `models` choice. */
export type AgentModel = ModelRef & { fallback?: true }

const modelLabel = (ref: ModelRef): string => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

/**
 * Fill one agent from its file. A created agent takes every field; an existing one
 * (another plugin's, or a host default) keeps what it has and gains the delivery
 * permissions after its own. A fallback model is marked in the fallback header.
 */
export function shapeAgent(draft: AgentDraft, file: AgentFile, model: AgentModel | undefined, created: boolean): void {
  draft.name ??= file.id
  if (created || draft.description === undefined) draft.description = file.description
  if (created || draft.mode === undefined) draft.mode = file.mode
  if (created || draft.system === undefined) draft.system = file.system
  const { fallback, ...ref } = model ?? {}
  const setModel = model !== undefined && (created || draft.model === undefined)
  if (setModel) draft.model = ref
  if (file.request?.headers) draft.request = { ...draft.request, headers: { ...file.request.headers, ...draft.request?.headers } }
  if (setModel && fallback)
    draft.request = { ...draft.request, headers: { ...draft.request?.headers, [MODEL_FALLBACK_HEADER]: modelLabel(ref as ModelRef) } }
  draft.permissions = created ? [...file.permissions] : [...(draft.permissions ?? []), ...file.permissions]
}

export const MODEL_ROLES_PLUGIN = "srobroek.model-roles"

/** Whether a `plugin.list` result includes the model-roles plugin. */
export function hasModelRoles(listed: unknown): boolean {
  return listsPlugin(listed, "model-roles")
}

/**
 * Agents another package owns; delivery ships each as a fallback copy, registered only
 * when the owner is not installed and no earlier plugin added the id (see
 * `@srobroek/opencode-lib/agent-fallback`). Keep the copy in sync with the owner's file.
 */
export const FALLBACK_AGENTS: FallbackOwners = { researcher: "agent-researcher" }

/**
 * The model to give an agent. An explicit `models` option wins; `false` means none.
 * Otherwise the file's model is a fallback for hosts without model-roles, where the
 * role header has no effect.
 */
export function fallbackModel(
  file: AgentFile,
  override: string | false | undefined,
  modelRoles: boolean,
  available: readonly Available[],
): AgentModel | undefined {
  if (override === false) return undefined
  if (override !== undefined) return availableModel(parseModel(override), available)
  if (modelRoles) return undefined
  const ref = availableModel(parseModel(file.model ?? ""), available)
  return ref === undefined ? undefined : { ...ref, fallback: true }
}

/** Read every shipped agent file. */
export function loadAgents(ids: readonly string[] = AGENT_IDS): AgentFile[] {
  return ids.map((id) => parseAgentFile(id, readFileSync(agentPath(id), "utf8")))
}
