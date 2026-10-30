import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { type AgentPermission, registerAgents } from "@srobroek/opencode-lib/agent-files"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { processAlive } from "@srobroek/opencode-lib/subprocess"
import { installFormulas, SETUP_DESCRIPTION, SETUP_INPUT, SETUP_TOOL } from "./formulas.ts"
import {
  type Exec,
  formatRun,
  outputDir,
  RUN_DESCRIPTION,
  RUN_INPUT,
  RUN_TOOL,
  readRunParams,
  resolveScript,
  runArgv,
  runBackground,
  runEnv,
  STOP_DESCRIPTION,
  STOP_INPUT,
  STOP_TOOL,
  type Start,
  spawnRun,
  startBackground,
  stopJob,
  VIEWER_SCRIPT,
  viewerSessionName,
  viewerStopArgs,
} from "./run.ts"
import { CadSessions } from "./sessions.ts"

export { FORMULAS, FORMULAS_DIR, installFormulas, SETUP_TOOL } from "./formulas.ts"
export { RUN_TOOL, readRunParams, resolveScript, runArgv, runEnv, STOP_TOOL, viewerSessionName } from "./run.ts"

export const PLUGIN_ID = "srobroek.cad"
/** How long a viewer host gets to stop when its session ends; `viewer.py` itself allows 60 s. */
const VIEWER_STOP_MS = 90_000
/** Parent sessions followed to find the session a subagent works for. */
const MAX_DEPTH = 16

/**
 * Agents may read the CAD skills' references and assets where the plugin is installed,
 * outside the project, without a prompt; every other external path keeps its own rule.
 */
export function skillReadRules(skillsDir: string): AgentPermission[] {
  const dirs = new Set([skillsDir])
  try {
    dirs.add(realpathSync(skillsDir))
  } catch {
    // A missing directory is reported by the skill registration instead.
  }
  return [...dirs].map((dir) => ({ action: "external_directory", resource: join(dir, "*"), effect: "allow" }))
}

/** Test seams; the host never passes them. */
export type Overrides = {
  exec?: Exec
  start?: Start
  alive?: (pid: number) => boolean
  stopGraceMs?: number
  eventHandled?: (event: unknown) => void
}

type Session = { location?: { directory?: unknown }; parentID?: string }

export async function setupCad(ctx: Context, moduleUrl: string, overrides: Overrides = {}) {
  const skillsDir = fileURLToPath(new URL("../skills", moduleUrl))
  const marker = `${PLUGIN_ID} ${dirname(skillsDir)}`
  const exec = overrides.exec ?? spawnRun
  const start = overrides.start ?? startBackground
  const alive = overrides.alive ?? processAlive
  const grace = overrides.stopGraceMs ?? 5_000
  const location = ctx.location.directory as string
  const { skills, agents } = contentPaths(moduleUrl)
  const owned = new CadSessions()
  const registrations: { dispose: () => Promise<void> }[] = []

  /** The session's directory, and the root session a subagent's session descends from. */
  const scope = async (sessionID: string) => {
    let directory = location
    let root = sessionID
    try {
      let info = (await ctx.session.get({ sessionID } as never)) as Session
      if (typeof info.location?.directory === "string") directory = info.location.directory
      for (let depth = 0; info.parentID && depth < MAX_DEPTH; depth++) {
        root = info.parentID
        info = (await ctx.session.get({ sessionID: info.parentID } as never)) as Session
      }
    } catch {
      // A session the host cannot return keeps the project directory and its own id.
    }
    return { directory, root }
  }
  const assert = (context: ToolContext, action: string, resources: string[], metadata: Record<string, unknown>) =>
    ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources,
      save: resources,
      metadata,
    } as never)
  const stopOwned = async (root: string) => {
    const { jobs, viewers } = owned.take(root)
    await Promise.allSettled([
      ...jobs.map((job) => stopJob(job, grace)),
      ...viewers.map((host) =>
        exec(runArgv(skillsDir, VIEWER_SCRIPT, viewerStopArgs(host.session)), {
          cwd: host.cwd,
          env: runEnv(process.env, root, marker),
          timeoutMs: VIEWER_STOP_MS,
        }),
      ),
    ])
  }

  const abort = new AbortController()
  const iterator = ctx.event.subscribe({ signal: abort.signal } as never)[Symbol.asyncIterator]()
  const cleanup = async () => {
    abort.abort()
    await iterator.return?.()
    await Promise.allSettled(owned.roots().map(stopOwned))
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  void (async () => {
    for (;;) {
      const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) return
      const event = next.value as { type?: string; data?: { sessionID?: unknown } }
      try {
        const sessionID = event.data?.sessionID
        if (event.type === "session.deleted" && typeof sessionID === "string") await stopOwned(sessionID)
      } catch (error) {
        console.error(`${PLUGIN_ID}: session cleanup failed`, error)
      } finally {
        overrides.eventHandled?.(next.value)
      }
    }
  })()

  try {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: SETUP_TOOL,
          description: SETUP_DESCRIPTION,
          input: SETUP_INPUT,
          execute: async (input, context) => {
            const { workspace, force } = (input ?? {}) as { workspace?: unknown; force?: unknown }
            if (workspace !== undefined && (typeof workspace !== "string" || workspace === ""))
              return { content: `${SETUP_TOOL}: workspace must be a non-empty string`, metadata: { ok: false } }
            const { directory } = await scope(context.sessionID)
            const target = resolve(directory, typeof workspace === "string" ? workspace : ".")
            await assert(context, SETUP_TOOL, [target], { workspace: target, force: force === true })
            const result = installFormulas(target, directory, force === true)
            return {
              content: result.ok ? result.text : `${SETUP_TOOL}: ${result.text}`,
              metadata: { ok: result.ok, copied: result.copied, unchanged: result.unchanged },
            }
          },
        })
        editor.add({
          name: RUN_TOOL,
          description: RUN_DESCRIPTION,
          input: RUN_INPUT,
          execute: async (input, context) => {
            const params = readRunParams(input)
            if (typeof params === "string") return { content: `${RUN_TOOL}: ${params}`, metadata: { ok: false } }
            const script = resolveScript(skillsDir, params.script)
            if (typeof script !== "string") return { content: `${RUN_TOOL}: ${script.error}`, metadata: { ok: false } }
            const { directory, root } = await scope(context.sessionID)
            await assert(context, RUN_TOOL, [script], { script, args: params.args, background: params.background })
            const argv = runArgv(skillsDir, script, params.args)
            const env = runEnv(process.env, root, marker)
            if (params.background) {
              const started = await runBackground(
                argv,
                { cwd: directory, env, script, timeoutSeconds: params.timeoutSeconds, dir: outputDir(root), signal: context.signal },
                start,
                alive,
              )
              if (started.job) {
                const tracked = started.job
                owned.addJob(root, tracked)
                // A script that exits on its own (serve.py's idle timeout) leaves nothing to stop.
                const forget = () => owned.removeJob(root, tracked)
                tracked.child.exited.then(forget, forget)
              }
              if (!started.ok) return { content: started.text, metadata: { ok: false, script, pid: started.job?.pid } }
              const { job } = started
              return {
                content: [
                  `${RUN_TOOL} ${script}: running in the background as pid ${job.pid}`,
                  started.firstLine,
                  `stdout: ${job.stdout}`,
                  `stderr: ${job.stderr}`,
                  `Stop it with ${STOP_TOOL} pid=${job.pid}; it also stops when this session is deleted.`,
                ].join("\n"),
                metadata: { ok: true, script, pid: job.pid, stdout: job.stdout, stderr: job.stderr },
              }
            }
            const began = performance.now()
            const run = await exec(argv, {
              cwd: directory,
              env,
              timeoutMs: params.timeoutSeconds * 1000,
              signal: context.signal,
            })
            const result = formatRun(script, run, (performance.now() - began) / 1000, () => outputDir(root))
            if (script === VIEWER_SCRIPT && result.ok) {
              const host = { cwd: directory, session: viewerSessionName(params.args) }
              if (params.args[0] === "serve") owned.addViewer(root, host)
              else if (params.args[0] === "stop") owned.removeViewer(root, host)
            }
            return {
              content: result.text,
              metadata: { ok: result.ok, script, exitCode: result.exitCode, status: result.status },
            }
          },
        })
        editor.add({
          name: STOP_TOOL,
          description: STOP_DESCRIPTION,
          input: STOP_INPUT,
          execute: async (input, context) => {
            const { pid } = (input ?? {}) as { pid?: unknown }
            if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
              return { content: `${STOP_TOOL}: pid must be a positive integer`, metadata: { ok: false } }
            const { root } = await scope(context.sessionID)
            const job = owned.takeJob(root, pid)
            if (job === undefined)
              return {
                content: `${STOP_TOOL}: pid ${pid} is not a background script ${RUN_TOOL} started in this session`,
                metadata: { ok: false },
              }
            const state = await stopJob(job, grace)
            return {
              content: `${STOP_TOOL}: ${job.script} (pid ${pid}) ${state === "gone" ? "had already exited" : "stopped"}`,
              metadata: { ok: true, pid, state },
            }
          },
        })
      }),
    )
    if (skills.length > 0) registrations.push(await registerSkills(ctx.skill, skills))
    if (agents.length > 0) registrations.push(await registerAgents(ctx.agent, agents, skillReadRules(skillsDir)))
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    setup: (ctx) => setupCad(ctx, import.meta.url, overrides),
  })
}

export default createPlugin()
