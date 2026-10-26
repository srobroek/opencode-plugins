import { isAbsolute, resolve } from "node:path"
import { Plugin, Skill, Worktree } from "@opencode/plugin"
import { shellCall } from "@srobroek/opencode-lib"
import { decideMergePolicy, type Probes } from "./merge-gate.ts"
import { type LoadedSkill, loadSkills } from "./skills.ts"
import { createStrategy, type Runner } from "./worktree.ts"

export { decideMergePolicy, MERGE_POLICY_REFUSAL, parseMergeInvocation } from "./merge-gate.ts"
export { createStrategy, STRATEGY_ID } from "./worktree.ts"

export type WorktrunkOptions = {
  /** Register `wt` as OpenCode's worktree strategy. Default `true`. */
  strategy: boolean
}

export function readOptions(options: Readonly<Record<string, unknown>> | undefined): WorktrunkOptions {
  return { strategy: options?.strategy !== false }
}

/** The shell call to check, or `undefined` when the call cannot run a merge. */
export function mergeGateCall(tool: string, input: unknown): { command: string; workdir?: string } | undefined {
  const call = shellCall(tool, input)
  if (!call || !/merge/.test(call.command)) return undefined
  return call.workdir === undefined ? { command: call.command } : { command: call.command, workdir: call.workdir }
}

/** The directory a shell call runs in: its `workdir`, resolved against the session's directory. */
export function shellCwd(workdir: string | undefined, sessionDirectory: string): string {
  if (workdir === undefined) return sessionDirectory
  return isAbsolute(workdir) ? workdir : resolve(sessionDirectory, workdir)
}

export function operationError(message: string, forceRequired?: boolean): Error {
  return forceRequired
    ? new Worktree.OperationError({ message, forceRequired: true })
    : new Worktree.OperationError({ message })
}

export function skillInfo(skill: LoadedSkill): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(skill.name),
    name: Skill.Name.make(skill.name),
    ...(skill.description === undefined ? {} : { description: skill.description }),
    autoinvoke: skill.autoinvoke,
    path: Skill.Info.fields.path.make(skill.path),
    content: skill.content,
  })
}

/** Test seams; the host never passes these. */
export type Overrides = { run?: Runner; probes?: Probes; skillsDirectory?: string }

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.worktrunk",
    async setup(ctx) {
      const options = readOptions(ctx.options)
      const registrations: { dispose: () => Promise<void> }[] = []
      const cleanup = async () => {
        for (const registration of registrations.reverse()) await registration.dispose()
      }
      try {
        if (options.strategy) {
          const strategy = createStrategy({ run: overrides.run, error: operationError })
          registrations.push(await ctx.worktree.transform((editor) => editor.add(strategy)))
        }

        registrations.push(
          await ctx.tool.hook("execute.before", async (event) => {
            const call = mergeGateCall(event.tool, event.input)
            if (!call) return
            const sessionDirectory = await ctx.session
              .get({ sessionID: event.sessionID })
              .then((session) => session.location.directory as string)
              .catch(() => ctx.location.directory as string)
            const cwd = shellCwd(call.workdir, sessionDirectory)
            const decision = await decideMergePolicy(call.command, cwd, overrides.probes)
            if (decision) throw new Error(decision.reason)
          }),
        )

        const skills = (await loadSkills(overrides.skillsDirectory)).map(skillInfo)
        registrations.push(
          await ctx.skill.transform((editor) => {
            for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill)
          }),
        )
      } catch (error) {
        await cleanup()
        throw error
      }
      return cleanup
    },
  })
}

export default createPlugin()
