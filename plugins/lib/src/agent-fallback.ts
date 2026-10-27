/**
 * Agents that one plugin owns and another ships as a fallback copy.
 *
 * A dedicated agent package (`srobroek.agent-<name>`) owns an agent; a bundle such as
 * delivery keeps an identical copy so work routed to that agent id never stalls when the
 * owner is not installed. Load order is not under either plugin's control, so both sides
 * cooperate:
 *
 * - the fallback side skips its copy when `plugin.list` reports the owner, or when an
 *   earlier transform already registered the id ({@link keepFallback});
 * - the owner side replaces a copy that registered first (same prompt) instead of layering
 *   over it ({@link registerOwnedAgents}).
 *
 * Either order leaves one agent with the owner's fields.
 */

import type { Context } from "@opencode/plugin/promise/plugin"
import { type AgentFile, readAgentFile, shapeAgent } from "./agent-files.ts"
import { MODEL_FALLBACK_HEADER } from "./model-roles.ts"

/** `plugin.list` during setup must not hold up startup; a slow answer counts as "not installed". */
export const PLUGIN_LIST_TIMEOUT_MS = 2000

type PluginEntry = { id?: unknown; source?: { target?: unknown; path?: unknown } }

/**
 * Whether a `plugin.list` result (a `{ data }` envelope or an array) includes the plugin
 * `srobroek.<name>`, by id, or by a package target or local path naming `<name>` or
 * `opencode-<name>`.
 */
export function listsPlugin(listed: unknown, name: string): boolean {
  const entries = Array.isArray(listed) ? listed : (listed as { data?: unknown } | undefined)?.data
  if (!Array.isArray(entries)) return false
  const target = new RegExp(`(^|[/:@])(opencode-)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
  const names = (value: unknown) => typeof value === "string" && target.test(value)
  return (entries as PluginEntry[]).some(
    (entry) => entry?.id === `srobroek.${name}` || names(entry?.source?.target) || names(entry?.source?.path),
  )
}

/** Fallback agent id to the name of the plugin that owns it (`agent-researcher` for `srobroek.agent-researcher`). */
export type FallbackOwners = Readonly<Record<string, string>>

/** The fallback agent ids whose owning plugin `plugin.list` reports installed. */
export function ownedElsewhere(listed: unknown, owners: FallbackOwners): Set<string> {
  return new Set(
    Object.entries(owners)
      .filter(([, owner]) => listsPlugin(listed, owner))
      .map(([id]) => id),
  )
}

/**
 * Whether the fallback side should register agent `id`. Agents without an owner always
 * register; a fallback registers only when its owner is not installed and no earlier
 * transform added the id.
 */
export function keepFallback(id: string, owners: FallbackOwners, owned: ReadonlySet<string>, exists: boolean): boolean {
  if (!(id in owners)) return true
  return !owned.has(id) && !exists
}

/** Whether `agent` is a fallback copy of `file` (same prompt), which the owner replaces. */
export function isCopyOf(agent: { system?: string } | undefined, file: AgentFile): boolean {
  return agent?.system !== undefined && agent.system === file.system
}

type Draft = {
  system?: string
  model?: unknown
  request?: { headers?: Record<string, string> }
  permissions?: AgentFile["permissions"]
}

/**
 * Owner side: fill one agent from its file. A fallback copy is reset first (its
 * permissions, fallback model and its fallback header dropped), so the result matches a
 * fresh registration;
 * any other existing agent keeps its own fields and gains the file's permissions after
 * its own, as `shapeAgent` does.
 */
export function applyOwnedAgent(draft: Draft, file: AgentFile, existing: { system?: string } | undefined): void {
  const copy = isCopyOf(existing, file)
  if (copy) {
    draft.permissions = []
    delete draft.model
    if (draft.request?.headers?.[MODEL_FALLBACK_HEADER] !== undefined) {
      const { [MODEL_FALLBACK_HEADER]: _, ...headers } = draft.request.headers
      draft.request = { ...draft.request, headers }
    }
  }
  shapeAgent(draft as never, file, existing === undefined || copy)
}

/** Owner side: register every agent file, replacing fallback copies. */
export async function registerOwnedAgents(agent: Context["agent"], paths: readonly string[]) {
  const files = paths.map(readAgentFile)
  return agent.transform((editor) => {
    for (const file of files) {
      const existing = editor.get(file.id)
      editor.update(file.id, (draft) => applyOwnedAgent(draft as unknown as Draft, file, existing))
    }
  })
}

/** The `plugin.list` result, or undefined when it fails or takes longer than `ms`. */
export async function listPlugins(plugin: Context["plugin"], ms = PLUGIN_LIST_TIMEOUT_MS): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([plugin.list(), timeout])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fallback side for a plugin without its own agent shaping: register every agent file as
 * `registerAgents` does, except a fallback copy whose owner is installed or whose id an
 * earlier transform already added.
 */
export async function registerFallbackAgents(ctx: Pick<Context, "agent" | "plugin">, paths: readonly string[], owners: FallbackOwners) {
  const files = paths.map(readAgentFile)
  const owned = files.some((file) => file.id in owners) ? ownedElsewhere(await listPlugins(ctx.plugin), owners) : new Set<string>()
  return ctx.agent.transform((editor) => {
    for (const file of files) {
      const created = editor.get(file.id) === undefined
      if (!keepFallback(file.id, owners, owned, !created)) continue
      editor.update(file.id, (draft) => shapeAgent(draft as never, file, created))
    }
  })
}
