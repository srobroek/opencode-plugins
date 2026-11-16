import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { agentPaths, registerAgents } from "@srobroek/opencode-lib/agent-files"
import { registerModeReminders } from "@srobroek/opencode-lib/mode-reminders"
import { guardShellCall } from "./git-guard.ts"
import { enabledModes, parseOptions, selectAgents } from "./modes.ts"
import { guardDebugWrite } from "./path-guard.ts"

export { AGENT_IDS, enabledModes, MODES, parseOptions, selectAgents } from "./modes.ts"

export const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url))

export async function setupModes(ctx: Context): Promise<() => Promise<void>> {
  const options = parseOptions(ctx.options as Record<string, unknown>)
  const disposers: Array<() => Promise<void>> = []
  const cleanup = async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
  try {
    const agents = await registerAgents(ctx.agent, selectAgents(agentPaths(AGENTS_DIR), options))
    disposers.push(() => agents.dispose())
    if (options.agents.debug || options.agents.refactor) {
      // Permission rules cannot see past git's global options (`git -C dir push`), so check the subcommand here.
      const guard = await ctx.tool.hook("execute.before", (event) => {
        const reason = guardShellCall(event.tool, event.input, event.agent as string)
        if (reason !== undefined) throw new Error(reason)
      })
      disposers.push(() => guard.dispose())
    }
    if (options.agents.debug) {
      // Permission globs cannot express "exactly one debug-* segment", so check the resolved path.
      const location = ctx.location.directory as string
      const writes = await ctx.tool.hook("execute.before", async (event) => {
        if (event.agent !== "debug") return
        const startDir = await ctx.session
          .get({ sessionID: event.sessionID })
          .then((session) => (session.location.directory as string) ?? location)
          .catch(() => location)
        const reason = guardDebugWrite(event.tool, event.input, event.agent as string, { startDir })
        if (reason !== undefined) throw new Error(reason)
      })
      disposers.push(() => writes.dispose())
    }
    const modes = enabledModes(options)
    if (options.reminders && modes.length > 0) disposers.push(await registerModeReminders(ctx, modes))
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

export default Plugin.define({ id: "srobroek.modes", setup: setupModes })
