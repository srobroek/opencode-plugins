import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { type AgentFields, loadAgents, shapeAgent } from "./agents.ts"
import {
  type Exec,
  installFormulas,
  type JourneysCommand,
  type JourneysIndexParams,
  journeysWrites,
  runJourneys,
} from "./journeys-tool.ts"

export { AGENT_IDS, parseAgentFile, shapeAgent } from "./agents.ts"
export { installFormulas, JOURNEYS_SCRIPT, journeysArgs, journeysWrites, runJourneys } from "./journeys-tool.ts"

export const SKILL_NAMES = [
  "journey-init",
  "journey-write",
  "journey-verify",
  "journey-verify-changed",
  "journey-campaign",
  "journey-consolidate",
] as const

export const SKILL_PATHS = SKILL_NAMES.map((name) =>
  fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
)

const COMMANDS: readonly JourneysCommand[] = ["index", "lint", "prune"]

/** Validate `journeys_index` input, or return why it is unusable. */
export function readIndexParams(input: unknown): JourneysIndexParams | string {
  const value = (input ?? {}) as Record<string, unknown>
  const command = value.command as JourneysCommand
  if (!COMMANDS.includes(command)) return "command must be index, lint or prune"
  if (typeof value.journeysDir !== "string" || value.journeysDir === "") return "journeysDir is required"
  const params: JourneysIndexParams = { command, journeysDir: value.journeysDir }
  if (value.keep !== undefined) {
    if (typeof value.keep !== "number" || !Number.isSafeInteger(value.keep) || value.keep < 0)
      return "keep must be a nonnegative safe integer"
    params.keep = value.keep
  }
  if (value.yes !== undefined) params.yes = value.yes === true
  if (value.journey !== undefined) {
    if (typeof value.journey !== "string" || value.journey === "") return "journey must be a non-empty string"
    params.journey = value.journey
  }
  return params
}

/** The permission resource for a writing `journeys_index` call. */
export function indexResource(params: JourneysIndexParams): string {
  if (params.command !== "prune") return `${params.command} ${params.journeysDir}`
  return `prune ${params.journeysDir} ${params.journey ?? "*all*"}`
}

/** Test seam; the host never passes it. */
export type Overrides = { exec?: Exec }

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.journeys",
    async setup(ctx) {
      const directory = (sessionID: string) =>
        ctx.session
          .get({ sessionID })
          .then((session) => session.location.directory as string)
          .catch(() => ctx.location.directory as string)
      const within = (base: string, path: string) => (isAbsolute(path) ? path : resolve(base, path))

      const tools = await ctx.tool.transform((editor) => {
        editor.add({
          name: "journeys_index",
          description:
            "Index, structurally lint (not semantic readiness), or prune a user-journeys directory by running the " +
            "bundled journeys.py helper. index rewrites INDEX.md; prune is a dry run unless yes=true. A run that " +
            "times out or is cancelled reports complete: false instead of an exit code.",
          input: {
            type: "object",
            properties: {
              command: { type: "string", enum: [...COMMANDS] },
              journeysDir: { type: "string", description: "Path to the journeys directory" },
              keep: { type: "integer", minimum: 0, description: "prune: keep the newest N runs (default 20)" },
              yes: { type: "boolean", description: "prune: actually delete (default dry run)" },
              journey: {
                type: "string",
                description:
                  "prune: the journey directory name to prune; omit only for an explicitly authorized directory-wide prune",
              },
            },
            required: ["command", "journeysDir"],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const params = readIndexParams(input)
            if (typeof params === "string") return { content: `journeys_index: ${params}`, metadata: { ok: false } }
            const cwd = await directory(context.sessionID)
            const resolved = { ...params, journeysDir: within(cwd, params.journeysDir) }
            if (journeysWrites(resolved)) {
              const resource = indexResource(resolved)
              await ctx.permission.assert({
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
                action: "journeys_index",
                resources: [resource],
                save: [resource],
                metadata: { ...resolved },
              })
            }
            const result = await runJourneys(cwd, resolved, context.signal, overrides.exec)
            const output =
              result.stdout && result.stderr ? `${result.stdout}\n${result.stderr}` : result.stdout || result.stderr
            if ("unrun" in result) {
              const text = [`journeys.py ${params.command} did not finish: ${result.unrun}`, output]
                .filter(Boolean)
                .join("\n")
              return {
                content: text,
                metadata: { ok: false, complete: false, command: params.command, unrun: result.unrun },
              }
            }
            return {
              content: output || `journeys.py ${params.command} exited ${result.exitCode}`,
              metadata: { ok: result.exitCode === 0, complete: true, command: params.command, exitCode: result.exitCode },
            }
          },
        })
        editor.add({
          name: "journey_install_formulas",
          description:
            "Copy the journeys plugin's formula TOMLs into a Beads workspace's .beads/formulas/. Identical copies " +
            "stay; divergent destinations are refused unless force=true; symlinked paths are always refused.",
          input: {
            type: "object",
            properties: {
              repoRoot: { type: "string", description: "Repository root containing .beads/" },
              force: { type: "boolean", description: "Overwrite divergent destination files" },
            },
            required: ["repoRoot"],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const { repoRoot, force } = (input ?? {}) as { repoRoot?: unknown; force?: unknown }
            if (typeof repoRoot !== "string" || repoRoot === "")
              return { content: "journey_install_formulas: repoRoot is required", metadata: { ok: false } }
            const cwd = await directory(context.sessionID)
            const resource = within(cwd, repoRoot)
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
              action: "journey_install_formulas",
              resources: [resource],
              save: [resource],
              metadata: { repoRoot: resource, force: force === true },
            })
            const result = installFormulas(repoRoot, force === true, cwd)
            return {
              content: result.text,
              metadata: { ok: result.ok, copied: result.copied, unchanged: result.unchanged },
            }
          },
        })
      })

      const files = loadAgents()
      const agents = await ctx.agent.transform((editor) => {
        for (const file of files) {
          const created = editor.get(file.id) === undefined
          editor.update(file.id, (agent) => shapeAgent(agent as unknown as AgentFields, file, created))
        }
      })
      const skills = await registerSkills(ctx.skill, SKILL_PATHS)
      return async () => {
        await skills.dispose()
        await agents.dispose()
        await tools.dispose()
      }
    },
  })
}

export default createPlugin()
