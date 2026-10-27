import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { agentPaths, registerAgents } from "@srobroek/opencode-lib/agent-files"
import { registerSkills, skillPaths } from "@srobroek/opencode-lib/skill-files"
import { isShellTool, WRITE_TOOLS } from "@srobroek/opencode-lib/tool-targets"
import { beadsActive } from "./beads.ts"
import { DEFAULT_INTEGRATION } from "./setup.ts"
import { rewriteSkill, type SkillLike, type SkillRouting, skillRefusal, staleSkills } from "./skills.ts"
import { type BeadsProbe, decideToolCall } from "./tasks-guard.ts"
import {
  executeSetup,
  executeStart,
  SETUP_DESCRIPTION,
  SETUP_TOOL,
  START_DESCRIPTION,
  START_INPUT,
  START_TOOL,
  setupInput,
} from "./tools.ts"
import { workflowLatch } from "./workflow.ts"

export { beadsActive } from "./beads.ts"
export { installFormulas, runSetup } from "./setup.ts"
export { IMPLEMENT_REDIRECT, rewriteSkill, skillRefusal, TASKSTOISSUES_REFUSAL } from "./skills.ts"
export { startSpec } from "./spec-start.ts"
export { runSpecStart } from "./spec-start-runtime.ts"
export { DENY_REASON, decideToolCall, isTasksMd, writesTasksMd } from "./tasks-guard.ts"
export { executeSetup, executeStart } from "./tools.ts"

export const WORKFLOW_PATH = fileURLToPath(new URL("../instructions/speckit-workflow.md", import.meta.url))
export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url))
export const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url))

/** Re-registrations of the skill transform allowed before a non-stale check resets the count. */
const MAX_REREGISTER = 3

export type SpeckitOptions = {
  /** spec-kit integration `speckit_setup` passes to `specify init`. Default `codex`. */
  integration: string
  /** Refuse writes of `specs/*\/tasks.md` where beads is active. Default true. */
  tasksGuard: boolean
  /** Replace the `speckit-implement` skill with the beads route where beads is active. Default true. */
  implementRedirect: boolean
  /** Refuse the taskstoissues skills where beads is active. Default true. */
  blockTasksToIssues: boolean
  /** Add the workflow instructions to sessions in a SpecKit repository. Default true. */
  workflow: boolean
  /** Register the speckit-sync and speckit-verify subagents. Default true. */
  agents: boolean
}

export function parseOptions(raw: Record<string, unknown> | undefined): SpeckitOptions {
  const options = raw ?? {}
  return {
    integration:
      typeof options.integration === "string" && options.integration.trim() !== ""
        ? options.integration.trim()
        : DEFAULT_INTEGRATION,
    tasksGuard: options.tasksGuard !== false,
    implementRedirect: options.implementRedirect !== false,
    blockTasksToIssues: options.blockTasksToIssues !== false,
    workflow: options.workflow !== false,
    agents: options.agents !== false,
  }
}

type SkillEditor = Parameters<Parameters<Context["skill"]["transform"]>[0]>[0]

/** Test seam; the host never passes it. */
export type Overrides = { probe?: BeadsProbe }

export async function setupSpeckit(ctx: Context, overrides: Overrides = {}): Promise<() => Promise<void>> {
  const options = parseOptions(ctx.options as Record<string, unknown>)
  const probe = overrides.probe ?? ((directory: string) => beadsActive(directory))
  const location = ctx.location.directory as string
  const disposers: Array<() => Promise<void>> = []
  const cleanup = async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
  const directory = (sessionID: string) =>
    ctx.session
      .get({ sessionID })
      .then((session) => (session.location.directory as string) ?? location)
      .catch(() => location)

  const assert = (context: ToolContext, action: string, resource: string, metadata: Record<string, unknown>) =>
    ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources: [resource],
      save: [resource],
      metadata,
    } as never)

  // Beads activity at this location decides the skill routing; speckit_setup can start it.
  let active = await probe(location)
  const routing = (): SkillRouting => ({
    implement: active && options.implementRedirect,
    taskstoissues: active && options.blockTasksToIssues,
  })
  let refreshSkills: (() => Promise<void>) | undefined

  try {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: SETUP_TOOL,
        description: SETUP_DESCRIPTION,
        input: setupInput(options.integration),
        execute: async (input, context) => {
          const cwd = await directory(context.sessionID)
          await assert(context, SETUP_TOOL, cwd, { ...(input as Record<string, unknown>) })
          const result = await executeSetup(input, cwd, options.integration)
          if (cwd === location) {
            active = await probe(location)
            await refreshSkills?.()
          }
          return result
        },
      })
      editor.add({
        name: START_TOOL,
        description: START_DESCRIPTION,
        input: START_INPUT,
        execute: async (input, context) => {
          const cwd = await directory(context.sessionID)
          const spec = (input as { spec?: unknown } | null)?.spec
          await assert(context, START_TOOL, typeof spec === "string" ? spec : "*", {
            ...(input as Record<string, unknown>),
          })
          return executeStart(input, cwd, context.signal)
        },
      })
    })
    disposers.push(() => tools.dispose())

    if (options.tasksGuard || options.blockTasksToIssues) {
      const before = await ctx.tool.hook("execute.before", async (event) => {
        if (options.blockTasksToIssues && event.tool === "skill") {
          const reason = skillRefusal(event.tool, event.input)
          if (reason !== undefined && (await probe(await directory(event.sessionID)))) throw new Error(reason)
          return
        }
        if (!options.tasksGuard || (!isShellTool(event.tool) && !WRITE_TOOLS.has(event.tool))) return
        let reason: string | undefined
        try {
          reason = await decideToolCall(event.tool, event.input, await directory(event.sessionID), probe)
        } catch {
          return
        }
        if (reason !== undefined) throw new Error(reason)
      })
      disposers.push(() => before.dispose())
    }

    if (options.implementRedirect || options.blockTasksToIssues) {
      // Project skills (spec-kit's `.agents/skills/`) load after plugins, so this transform
      // re-registers last whenever one of them still has upstream content.
      const apply = (editor: SkillEditor) => {
        const current = routing()
        for (const skill of editor.list() as ReadonlyArray<SkillLike>) {
          const next = rewriteSkill(skill, current)
          if (next !== undefined) editor.update(skill.id, (draft) => Object.assign(draft, next))
        }
      }
      let registration = await ctx.skill.transform(apply)
      let attempts = 0
      let queue: Promise<void> = Promise.resolve()
      const controller = new AbortController()
      const check = async () => {
        if (controller.signal.aborted) return
        const listed = (await ctx.skill.list()) as unknown as { data?: SkillLike[] } | SkillLike[]
        if (!staleSkills(Array.isArray(listed) ? listed : (listed.data ?? []), routing())) {
          attempts = 0
          return
        }
        if (attempts >= MAX_REREGISTER) return
        attempts++
        const next = await ctx.skill.transform(apply)
        if (controller.signal.aborted) {
          await next.dispose()
          return
        }
        const previous = registration
        registration = next
        await previous.dispose()
      }
      const enqueue = () => {
        queue = queue.then(check).catch(() => {})
        return queue
      }
      refreshSkills = async () => {
        attempts = 0
        await enqueue()
      }
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal } as never)) {
          if (controller.signal.aborted) break
          const type = (event as { type?: unknown } | null)?.type
          if (type === "skill.updated") void enqueue()
        }
      })().catch(() => {})
      void enqueue()
      disposers.push(async () => {
        controller.abort()
        await queue
        await registration.dispose()
      })
    }

    if (options.workflow) {
      const text = readFileSync(WORKFLOW_PATH, "utf8").trim()
      const latch = workflowLatch()
      const context = await ctx.session.hook("context", async (event) => {
        if (await latch.include(event.sessionID, event.agent, () => directory(event.sessionID)))
          event.system.push({ type: "text", text })
      })
      disposers.push(async () => {
        await context.dispose()
        latch.clear()
      })
    }

    const skills = await registerSkills(ctx.skill, skillPaths(SKILLS_DIR))
    disposers.push(() => skills.dispose())

    if (options.agents) {
      const agents = await registerAgents(ctx.agent, agentPaths(AGENTS_DIR))
      disposers.push(() => agents.dispose())
    }
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.speckit",
    setup: (ctx) => setupSpeckit(ctx, overrides),
  })
}

export default createPlugin()
