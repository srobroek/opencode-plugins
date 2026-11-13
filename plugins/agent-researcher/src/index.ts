/**
 * The agent-researcher plugin: ships the `researcher` subagent, which answers one scoped
 * question from the codebase, docs and the web with cited observations kept apart from
 * inferences.
 *
 * The id stays `researcher` so beads formulas that route `execution_agent_type=researcher`
 * keep working. Delivery ships an identical fallback copy for hosts without this plugin;
 * `registerOwnedAgents` replaces that copy when it registered first.
 */

import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerOwnedAgents } from "@srobroek/opencode-lib/agent-fallback"
import { agentPaths } from "@srobroek/opencode-lib/agent-files"
import { toolRulesFromOption } from "@srobroek/opencode-lib/agent-tools"

export const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url))
export const RESEARCHER = "researcher"

export default Plugin.define({
  id: "srobroek.agent-researcher",
  async setup(ctx) {
    const agents = await registerOwnedAgents(ctx.agent, agentPaths(AGENTS_DIR), {
      agents: [RESEARCHER],
      rules: toolRulesFromOption((ctx.options as Record<string, unknown> | undefined)?.tools),
    })
    return () => agents.dispose()
  },
})
