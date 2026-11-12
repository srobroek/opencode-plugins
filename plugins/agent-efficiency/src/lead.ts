import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Context } from "@opencode/plugin/promise/plugin"
import { onSessionDeleted } from "./session-cache.ts"

export const LEAD_PATH = fileURLToPath(new URL("../instructions/lead-routing.md", import.meta.url))

export function filterLeadRouting(text: string, registered: ReadonlySet<string>): string {
  return text.split("\n").filter((line) => {
    if (!line.startsWith("- ")) return true
    const ids = [...line.split(":")[0]?.matchAll(/`([^`]+)`/g) ?? []].map((match) => match[1] as string)
    return ids.length === 0 || ids.some((id) => registered.has(id))
  }).join("\n")
}

export async function setupLead(ctx: Context): Promise<() => Promise<void>> {
  const text = readFileSync(LEAD_PATH, "utf8").trim()
  const cached = new Map<string, Promise<string | undefined>>()
  const stop = onSessionDeleted(ctx, (sessionID) => cached.delete(sessionID))
  const forSession = async (sessionID: string): Promise<string | undefined> => {
    try {
      const session = await ctx.session.get({ sessionID })
      if (session.parentID != null) return undefined
      const agents = await ctx.agent.list()
      // The shared fake uses the editor's array shape; the client wraps it in data.
      const listed: readonly { id: string }[] = Array.isArray(agents) ? agents : agents.data
      return filterLeadRouting(text, new Set(listed.map((agent) => agent.id)))
    } catch { return undefined }
  }
  const inject = async (event: { sessionID: string; tools: object; system: Array<{ type: "text"; text: string }> }) => {
    if (!("subagent" in event.tools)) return
    let known = cached.get(event.sessionID)
    if (!known) {
      known = forSession(event.sessionID)
      cached.set(event.sessionID, known)
    }
    const routing = await known
    if (routing) event.system.push({ type: "text", text: routing })
  }
  const hooks = [await ctx.session.hook("context", inject), await ctx.session.hook("compaction", inject), await ctx.session.hook("generate", inject)]
  return async () => {
    await stop()
    for (const hook of hooks) await hook.dispose()
    cached.clear()
  }
}
