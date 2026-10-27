import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { appendResultText, shellCall, shellExit } from "@srobroek/opencode-lib"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { decideCommitGate } from "./commit-gate.ts"
import { flagCleanupFollowUp, landedMerge, type MergeRequest, shellMerges } from "./flag-cleanup.ts"
import { decideMrAdvisory } from "./mr-advisory.ts"
import { skipCiAdvisory } from "./skip-ci.ts"

export { COMMIT_OVERRIDE, conventional, decideCommitGate, MESSAGES, PUSH_OVERRIDE } from "./commit-gate.ts"
export {
  createCleanup,
  decideFlagCleanup,
  flagCleanupFollowUp,
  landedMerge,
  mergedForgeData,
  shellMerges,
} from "./flag-cleanup.ts"
export { ADVICE, decideMrAdvisory } from "./mr-advisory.ts"
export { SKIP_CI_ADVISORY, skipCiAdvisory } from "./skip-ci.ts"

export const LAND_TOOL = "delivery_land"

export const SKILL_NAMES = ["trunk-dev-workflow", "trunk-dev-feature-flags", "trunk-dev-release-setup", "trunk-dev-guide"] as const

export const SKILL_PATHS = SKILL_NAMES.map((name) =>
  fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
)

export const FEATURE_IDS = ["commit-gate", "skip-ci", "mr-advisory", "flag-cleanup"] as const
export type FeatureID = (typeof FEATURE_IDS)[number]

/** `{ disable: ["commit-gate", …] }` turns features off; unknown ids are ignored. */
export function readOptions(options: Readonly<Record<string, unknown>> | undefined): ReadonlySet<FeatureID> {
  const raw = options?.disable
  const list = Array.isArray(raw) ? raw.filter((id): id is FeatureID => FEATURE_IDS.includes(id as FeatureID)) : []
  return new Set(list)
}

/** The directory a shell call runs in: its `workdir`, resolved against the session's directory. */
export function shellCwd(workdir: string | undefined, sessionDirectory: string): string {
  if (workdir === undefined) return sessionDirectory
  return isAbsolute(workdir) ? workdir : resolve(sessionDirectory, workdir)
}

/** The advisories for one completed shell call, skip-CI first. */
export function shellAdvisories(
  command: string,
  cwd: string,
  disabled: ReadonlySet<FeatureID>,
  advise: (command: string, cwd: string) => string[] = decideMrAdvisory,
): string[] {
  const out: string[] = []
  if (!disabled.has("skip-ci")) {
    const skip = skipCiAdvisory(command, cwd)
    if (skip !== undefined) out.push(skip)
  }
  if (!disabled.has("mr-advisory")) out.push(...advise(command, cwd))
  return out
}

/** Test seams; the host never passes these. */
export type Overrides = {
  commitGate?: (command: string, cwd: string) => { reason: string } | undefined
  advise?: (command: string, cwd: string) => string[]
  followUp?: (merges: readonly MergeRequest[]) => Promise<string | undefined>
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.trunk-dev",
    async setup(ctx) {
      const disabled = readOptions(ctx.options as Record<string, unknown> | undefined)
      const gate = overrides.commitGate ?? ((command: string, cwd: string) => decideCommitGate(command, cwd))
      const followUp = overrides.followUp ?? ((merges) => flagCleanupFollowUp(merges, process.env))
      const sessionDirectory = (sessionID: string): Promise<string> =>
        ctx.session
          .get({ sessionID } as never)
          .then((session) => (session as { location: { directory: string } }).location.directory)
          .catch(() => ctx.location.directory as string)

      const before = await ctx.tool.hook("execute.before", async (event) => {
        if (disabled.has("commit-gate")) return
        const call = shellCall(event.tool, event.input)
        if (call === undefined) return
        const cwd = shellCwd(call.workdir, await sessionDirectory(event.sessionID))
        let refusal: { reason: string } | undefined
        try {
          refusal = gate(call.command, cwd)
        } catch {
          refusal = undefined
        }
        if (refusal !== undefined) throw new Error(`trunk-dev: ${refusal.reason}`)
      })

      const after = await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed") return
        try {
          const notes: string[] = []
          let merges: MergeRequest[] = []
          const directory = await sessionDirectory(event.sessionID)
          if (event.tool === LAND_TOOL) {
            const landed = landedMerge(event.result.output, directory)
            if (landed !== undefined) merges = [landed]
          } else {
            const call = shellCall(event.tool, event.input)
            if (call === undefined) return
            const exit = shellExit(event.result)
            if (exit !== undefined && exit !== 0) return
            const cwd = shellCwd(call.workdir, directory)
            notes.push(...shellAdvisories(call.command, cwd, disabled, overrides.advise))
            if (exit === 0) merges = shellMerges(call.command, cwd)
          }
          if (!disabled.has("flag-cleanup") && merges.length > 0) {
            const note = await followUp(merges).catch(() => undefined)
            if (note !== undefined) notes.push(note)
          }
          if (notes.length > 0) event.result = appendResultText(event.result, notes.join("\n"))
        } catch {
          // Advisories and follow-ups never fail the call they observe.
        }
      })

      const skills = await registerSkills(ctx.skill, SKILL_PATHS)

      return async () => {
        await skills.dispose()
        await after.dispose()
        await before.dispose()
      }
    },
  })
}

export default createPlugin()
