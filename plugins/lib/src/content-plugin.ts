/**
 * A plugin that only ships content: `skills/<name>/SKILL.md` and `agents/<id>.md` at the
 * package root. Both directories sit one level above `src/` and the bundled `dist/`.
 */

import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { type FallbackOwners, registerFallbackAgents } from "./agent-fallback.ts"
import { agentPaths } from "./agent-files.ts"
import { registerSkills, skillPaths } from "./skill-files.ts"

export type ContentPaths = { skills: string[]; agents: string[] }

/** The shipped skill and agent files of the package whose module URL is `moduleUrl`. */
export function contentPaths(moduleUrl: string): ContentPaths {
  return {
    skills: skillPaths(fileURLToPath(new URL("../skills", moduleUrl))),
    agents: agentPaths(fileURLToPath(new URL("../agents", moduleUrl))),
  }
}

export type ContentOptions = {
  /**
   * Agents this package ships as fallback copies of another package's, by owner plugin
   * name (see `./agent-fallback.ts`). Each registers only when its owner is not installed.
   */
  fallbacks?: FallbackOwners
}

/** Define plugin `id`, registering the skills and agents found next to `moduleUrl`. */
export function contentPlugin(id: string, moduleUrl: string, options: ContentOptions = {}) {
  return Plugin.define({
    id,
    async setup(ctx) {
      const { skills, agents } = contentPaths(moduleUrl)
      const registrations: { dispose: () => Promise<void> }[] = []
      const cleanup = async () => {
        for (const registration of registrations.reverse()) await registration.dispose()
      }
      try {
        if (skills.length > 0) registrations.push(await registerSkills(ctx.skill, skills))
        if (agents.length > 0) registrations.push(await registerFallbackAgents(ctx, agents, options.fallbacks ?? {}))
      } catch (error) {
        await cleanup()
        throw error
      }
      return cleanup
    },
  })
}
