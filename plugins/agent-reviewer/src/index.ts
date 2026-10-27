/**
 * The agent-reviewer plugin: ships the read-only reviewer subagents and the hidden
 * `review-security` skill they load.
 *
 * `pr-reviewer` and `adversarial-challenger` keep their ids, so delivery's verdict hook and
 * any formula that routes them keep working. Delivery and quality ship identical fallback
 * copies of those two for hosts without this plugin; `registerOwnedAgents` replaces a copy
 * that registered first. Each agent's prompt is composed at build time from
 * `agents.src/<id>.md` and the shared review core in `@srobroek/opencode-lib`.
 */

import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerOwnedAgents } from "@srobroek/opencode-lib/agent-fallback"
import { agentPaths } from "@srobroek/opencode-lib/agent-files"
import { registerSkills, skillPaths } from "@srobroek/opencode-lib/skill-files"

export const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url))
export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url))
export const REVIEWERS = ["adversarial-challenger", "code-reviewer", "pr-reviewer", "security-reviewer"] as const

export default Plugin.define({
  id: "srobroek.agent-reviewer",
  async setup(ctx) {
    const skills = await registerSkills(ctx.skill, skillPaths(SKILLS_DIR))
    try {
      const agents = await registerOwnedAgents(ctx.agent, agentPaths(AGENTS_DIR))
      return async () => {
        await agents.dispose()
        await skills.dispose()
      }
    } catch (error) {
      await skills.dispose()
      throw error
    }
  },
})
