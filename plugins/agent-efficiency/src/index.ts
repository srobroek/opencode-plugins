import { Plugin } from "@opencode/plugin"
import { SHELL_ALIASES, SHELL_TOOL, shellAliasInput } from "@srobroek/opencode-lib/tool-targets"

export type Route = { tool: string; input: unknown }

/**
 * The `shell` call a shell-alias call (`bash`, `Bash`) runs as, or `undefined` to leave
 * the call alone: another tool, or an alias some plugin registered as a real tool.
 */
export function routeShellAlias(tool: string, input: unknown, registered: (id: string) => boolean): Route | undefined {
  if (!SHELL_ALIASES.has(tool) || registered(tool)) return undefined
  return { tool: SHELL_TOOL, input: shellAliasInput(input) }
}

export default Plugin.define({
  id: "srobroek.agent-efficiency",
  async setup(ctx) {
    if (ctx.options.bashAlias === false) return
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
    return async () => {
      await alias.dispose()
    }
  },
})
