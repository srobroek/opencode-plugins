import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { appendResultText } from "@srobroek/opencode-lib/shell-result"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { ADVISORIES, advisoriesFor } from "./advisories.ts"
import { decideToolCall } from "./migration-gate.ts"

export { ADVISORIES, advisoriesFor, runsCargoInstall } from "./advisories.ts"
export { decidePath, decideToolCall, latestMigration, migrationTarget } from "./migration-gate.ts"

export const SKILL_NAMES = [
  "rust-quality",
  "rust-ci",
  "rust-contract-boundary",
  "rust-crate-boundaries",
  "rust-domain-modeling",
  "rust-persistence",
  "rust-safe-mutation",
  "rust-tauri",
  "rust-workspace",
] as const

export const SKILL_PATHS = SKILL_NAMES.map((name) =>
  fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
)

export default Plugin.define({
  id: "srobroek.rust",
  async setup(ctx) {
    const directory = (sessionID: string) =>
      ctx.session
        .get({ sessionID })
        .then((session) => session.location.directory as string)
        .catch(() => ctx.location.directory as string)
    /** Advisories already shown, per session, so each appears once. */
    const shown = new Set<string>()

    const gate = await ctx.tool.hook("execute.before", async (event) => {
      if (!["edit", "write", "patch", "shell"].includes(event.tool)) return
      const reason = decideToolCall(event.tool, event.input, await directory(event.sessionID))
      if (reason) throw new Error(reason)
    })
    const advisory = await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || !["edit", "write", "patch", "shell"].includes(event.tool)) return
      const ids = advisoriesFor(event.tool, event.input, await directory(event.sessionID)).filter(
        (id) => !shown.has(`${event.sessionID}:${id}`),
      )
      if (ids.length === 0) return
      for (const id of ids) shown.add(`${event.sessionID}:${id}`)
      event.result = appendResultText(event.result, ids.map((id) => ADVISORIES[id]).join("\n\n"))
    })
    const skills = await registerSkills(ctx.skill, SKILL_PATHS)
    return async () => {
      await skills.dispose()
      await advisory.dispose()
      await gate.dispose()
    }
  },
})
