import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { agentPaths, registerAgents } from "@srobroek/opencode-lib/agent-files"
import { registerModeReminders } from "@srobroek/opencode-lib/mode-reminders"
import { GUARDED_AGENTS, inspectShellCall } from "./git-guard.ts"
import { headRefusal } from "./head-guard.ts"
import { enabledModes, parseOptions, selectAgents } from "./modes.ts"
import { guardDebugWrite } from "./path-guard.ts"

export { AGENT_IDS, enabledModes, MODES, parseOptions, selectAgents } from "./modes.ts"

export const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url))

/** Test seam; the host never passes it. */
export type Overrides = {
  /** Why a mutating git command may not run in this workdir; defaults to reading HEAD with git. */
  headCheck?: (workdir: string | undefined) => Promise<string | undefined>
}

export async function setupModes(ctx: Context, overrides: Overrides = {}): Promise<() => Promise<void>> {
  const headCheck = overrides.headCheck ?? ((workdir: string | undefined) => headRefusal(workdir))
  const options = parseOptions(ctx.options as Record<string, unknown>)
  const disposers: Array<() => Promise<void>> = []
  const cleanup = async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
  try {
    const agents = await registerAgents(ctx.agent, selectAgents(agentPaths(AGENTS_DIR), options))
    disposers.push(() => agents.dispose())
    const location = ctx.location.directory as string
    // The directory a session started in is its checkout, which the guards keep out of reach.
    const startDirectory = (sessionID: string) =>
      ctx.session
        .get({ sessionID })
        .then((session) => (session.location.directory as string) ?? location)
        .catch(() => location)
    if (options.agents.debug || options.agents.refactor) {
      // Permission rules cannot see past git's global options (`git -C dir push`), so check the subcommand here.
      const guard = await ctx.tool.hook("execute.before", async (event) => {
        if (!GUARDED_AGENTS.includes(event.agent as string)) return
        const inspected = inspectShellCall(event.tool, event.input, event.agent as string, { startDir: await startDirectory(event.sessionID) })
        if (inspected.reason !== undefined) throw new Error(inspected.reason)
        // A linked worktree shares branches: only commit on a debug branch or a detached HEAD, never on one the user owns.
        if (inspected.mutates) {
          const head = await headCheck(inspected.workdir)
          if (head !== undefined) throw new Error(head)
        }
      })
      disposers.push(() => guard.dispose())
    }
    if (options.agents.debug) {
      // Permission globs cannot express "exactly one debug-* segment", so check the resolved path.
      const writes = await ctx.tool.hook("execute.before", async (event) => {
        if (event.agent !== "debug") return
        const reason = guardDebugWrite(event.tool, event.input, event.agent as string, {
          startDir: await startDirectory(event.sessionID),
        })
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

export default Plugin.define({ id: "srobroek.modes", setup: (ctx) => setupModes(ctx) })
