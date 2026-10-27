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

type Draft = { system?: string; model?: unknown; permissions?: AgentFile["permissions"] }

/**
 * Owner side: fill one agent from its file. A fallback copy is reset first (its
 * permissions and fallback model dropped), so the result matches a fresh registration;
 * any other existing agent keeps its own fields and gains the file's permissions after
 * its own, as `shapeAgent` does.
 */
export function applyOwnedAgent(draft: Draft, file: AgentFile, existing: { system?: string } | undefined): void {
  const copy = isCopyOf(existing, file)
  if (copy) {
    draft.permissions = []
    delete draft.model
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
