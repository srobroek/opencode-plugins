/**
 * A plugin that only ships content: `skills/<name>/SKILL.md` and `agents/<id>.md` at the
 * package root. Both directories sit one level above `src/` and the bundled `dist/`.
 */

import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { agentPaths, registerAgents } from "./agent-files.ts"
import { registerSkills, skillPaths } from "./skill-files.ts"

export type ContentPaths = { skills: string[]; agents: string[] }

/** The shipped skill and agent files of the package whose module URL is `moduleUrl`. */
export function contentPaths(moduleUrl: string): ContentPaths {
  return {
    skills: skillPaths(fileURLToPath(new URL("../skills", moduleUrl))),
    agents: agentPaths(fileURLToPath(new URL("../agents", moduleUrl))),
  }
}

/** Define plugin `id`, registering the skills and agents found next to `moduleUrl`. */
export function contentPlugin(id: string, moduleUrl: string) {
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
        if (agents.length > 0) registrations.push(await registerAgents(ctx.agent, agents))
      } catch (error) {
        await cleanup()
        throw error
      }
      return cleanup
    },
  })
}
