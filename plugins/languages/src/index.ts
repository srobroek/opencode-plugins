import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"

export const SKILL_NAMES = ["go-quality", "python-quality", "typescript-quality"] as const

export const SKILL_PATHS = SKILL_NAMES.map((name) =>
  fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
)

export default Plugin.define({
  id: "srobroek.languages",
  async setup(ctx) {
    const skills = await registerSkills(ctx.skill, SKILL_PATHS)
    return () => skills.dispose()
  },
})
