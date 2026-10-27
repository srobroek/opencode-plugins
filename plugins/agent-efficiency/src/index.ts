import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { SHELL_ALIASES, SHELL_TOOL, shellAliasInput } from "@srobroek/opencode-lib/tool-targets"
import { EXPLORE_ID, shapeExplore } from "./explore.ts"
import { globalConfigDirs, leanSystem, parseLeanOptions } from "./lean.ts"

export * from "./explore.ts"
export * from "./lean.ts"

export type Route = { tool: string; input: unknown }

/**
 * The `shell` call a shell-alias call (`bash`, `Bash`) runs as, or `undefined` to leave
 * the call alone: another tool, or an alias some plugin registered as a real tool.
 */
export function routeShellAlias(tool: string, input: unknown, registered: (id: string) => boolean): Route | undefined {
  if (!SHELL_ALIASES.has(tool) || registered(tool)) return undefined
  return { tool: SHELL_TOOL, input: shellAliasInput(input) }
}

/** `dirs` plus the resolved path of each, since OpenCode names the global AGENTS.md by its real path. */
function withRealPaths(dirs: ReadonlyArray<string>): string[] {
  const resolved = dirs.flatMap((dir) => {
    try {
      return [realpathSync(dir)]
    } catch {
      return []
    }
  })
  return [...new Set([...dirs, ...resolved])]
}

export default Plugin.define({
  id: "srobroek.agent-efficiency",
  async setup(ctx) {
    const options = ctx.options as Record<string, unknown>
    const disposers: Array<() => Promise<void>> = []

    if (options.bashAlias !== false) {
      // OpenCode runs execute.before before it looks the tool up, so renaming the call here
      // runs the built-in shell tool itself: its permission prompts, timeout and background
      // jobs, and every execute.after hook keyed on `shell`. No tool is added to the request.
      const alias = await ctx.tool.hook("execute.before", async (event) => {
        if (!SHELL_ALIASES.has(event.tool)) return
        const tools = await ctx.tool.list()
        const route = routeShellAlias(event.tool, event.input, (id) => tools.some((tool) => tool.id === id))
        if (route === undefined) return
        event.tool = route.tool
        event.input = route.input
      })
      disposers.push(() => alias.dispose())
    }

    if (options.explore !== false) {
      const agents = await ctx.agent.transform((editor) => {
        if (editor.get(EXPLORE_ID) === undefined) return
        editor.update(EXPLORE_ID, (draft) => shapeExplore(draft as never))
      })
      disposers.push(() => agents.dispose())
    }

    const lean = parseLeanOptions(options)
    if (lean !== undefined) {
      const child = new Map<string, Promise<boolean>>()
      const globalDirs = withRealPaths(globalConfigDirs(process.env, homedir()))
      const isChild = async (sessionID: string) => {
        try {
          const session = (await ctx.session.get({ sessionID } as never)) as { parentID?: string | null } | undefined
          return typeof session?.parentID === "string"
        } catch {
          return false
        }
      }
      // Also on compaction and generate, so those requests keep the turns' system prompt and prompt cache.
      const trim = async (event: { sessionID: string; agent: string; system: Array<{ type: "text"; text: string }> }) => {
        if (!lean.agents.has(event.agent)) return
        let known = child.get(event.sessionID)
        if (known === undefined) {
          known = isChild(event.sessionID)
          child.set(event.sessionID, known)
        }
        if (await known) event.system.splice(0, event.system.length, ...leanSystem(event.system, lean.drop, globalDirs))
      }
      const hooks = [
        await ctx.session.hook("context", trim),
        await ctx.session.hook("compaction", trim),
        await ctx.session.hook("generate", trim),
      ]
      disposers.push(async () => {
        for (const hook of hooks) await hook.dispose()
        child.clear()
      })
    }

    return async () => {
      for (const dispose of disposers.reverse()) await dispose()
    }
  },
})
