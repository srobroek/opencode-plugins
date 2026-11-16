import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { agentPaths, registerAgents } from "@srobroek/opencode-lib/agent-files"
import { registerModeReminders } from "@srobroek/opencode-lib/mode-reminders"
import { isShellTool } from "@srobroek/opencode-lib/tool-targets"
import { forbiddenGitInput } from "./git-guard.ts"
import { enabledModes, parseOptions, selectAgents } from "./modes.ts"

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
        if (!isShellTool(event.tool)) return
        const reason = forbiddenGitInput(event.input, event.agent as string)
        if (reason !== undefined) throw new Error(reason)
      })
      disposers.push(() => guard.dispose())
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
