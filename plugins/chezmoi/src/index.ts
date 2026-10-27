import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { isShellTool, WRITE_TOOLS } from "@srobroek/opencode-lib/tool-targets"
import { createGuard, type GuardOptions } from "./guard.ts"

export { createGuard, MANAGED_TTL_MS, refusal } from "./guard.ts"

export const SKILL_PATH = fileURLToPath(new URL("../skills/chezmoi-editor/SKILL.md", import.meta.url))

/** Test seam; the host never passes it. */
export function createPlugin(overrides: GuardOptions = {}) {
  return Plugin.define({
    id: "srobroek.chezmoi",
    async setup(ctx) {
      const guard = createGuard(overrides)
      const before = await ctx.tool.hook("execute.before", async (event) => {
        if (!isShellTool(event.tool) && !WRITE_TOOLS.has(event.tool)) return
        const directory = await ctx.session
          .get({ sessionID: event.sessionID })
          .then((session) => session.location.directory as string)
          .catch(() => ctx.location.directory as string)
        const reason = await guard.decide(event.tool, event.input, directory)
        if (reason) throw new Error(reason)
      })
      const skills = await registerSkills(ctx.skill, [SKILL_PATH])
      return async () => {
        await skills.dispose()
        await before.dispose()
      }
    },
  })
}

export default createPlugin()
