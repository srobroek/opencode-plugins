import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { type DepRow, detectProject } from "@srobroek/opencode-lib/dep-detect"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { AGENT_ID, decideEvaluation, reportOnlyPermissions } from "./report-only.ts"

export { commandMutates, decideEvaluation, isDependencyFile, reportOnlyPermissions } from "./report-only.ts"

export const SKILL_PATH = fileURLToPath(new URL("../skills/whats-new/SKILL.md", import.meta.url))

export const AGENT_PROMPT = [
  "You are the whats-new agent: you research what changed between the version of a dependency, tool or",
  "service that a project uses and the latest one, and you report it. You never upgrade anything.",
  "Load the `whats-new` skill and follow it. Start from the `version_gap_scan` tool when no target is named.",
  "Dependency manifests, lockfiles, installers, upgrade commands and `dep_apply` are denied to you; the",
  "finding belongs in the report. If the user wants an upgrade applied, say so and leave it to dep-update.",
].join("\n")

/** One tab-separated row per dependency: ecosystem, name, declared, resolved (`?` when unlocked), direct|transitive. */
export function formatRows(rows: readonly DepRow[]): string {
  return rows
    .map(({ ecosystem, name, declared, resolved, direct }) =>
      [ecosystem, name, declared, resolved ?? "?", direct ? "direct" : "transitive"].join("\t"),
    )
    .join("\n")
}

export type AgentFields = {
  name?: string
  description?: string
  mode?: string
  system?: string
  permissions?: unknown[]
}

/**
 * Shape the whats-new agent: description, prompt and the report-only rules after any
 * existing ones. A `created` agent also gets mode `all`; the host fills a new agent's
 * mode with `primary` before the callback runs, so only a configured agent keeps its own.
 */
export function shapeAgent(agent: AgentFields, created: boolean): void {
  agent.name ??= AGENT_ID
  agent.description ??=
    "Research breaking changes, deprecations and new features between the version in use and the latest. Report-only."
  if (created || agent.mode === undefined) agent.mode = "all"
  agent.system ??= AGENT_PROMPT
  agent.permissions = [...(agent.permissions ?? []), ...reportOnlyPermissions()]
}

export default Plugin.define({
  id: "srobroek.whats-new",
  async setup(ctx) {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "version_gap_scan",
        description:
          "List a project's root dependencies with declared and locked versions, offline and read-only.\n" +
          "Reads npm (package.json + package-lock.json), " +
          "Python (pyproject.toml or requirements.txt + uv.lock/poetry.lock), Cargo.toml, go.mod, Gemfile, composer.json. " +
          "One tab-separated row per dependency: ecosystem, name, declared spec, resolved lockfile version ('?' when " +
          "unlocked), direct|transitive. Use resolved as the installed version when present. Input for what's-new research.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Project root to scan; defaults to the session directory" },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const path = (input as { path?: string }).path
          const dir = !path ? ctx.location.directory : isAbsolute(path) ? path : resolve(ctx.location.directory, path)
          const { exit, rows, stderr, coverage } = await detectProject(dir)
          if (exit !== 0) return { content: `version_gap_scan failed (exit ${exit}):\n${stderr}`, metadata: { exit } }
          const deps = rows.map(({ ecosystem, name, declared, resolved, direct }) => ({
            ecosystem,
            name,
            declared,
            resolved,
            direct,
          }))
          const text = [formatRows(rows), stderr.trim()].filter(Boolean).join("\n")
          return { content: text, metadata: { deps, coverage, count: deps.length } }
        },
      })
    })
    const agents = await ctx.agent.transform((editor) => {
      const created = editor.get(AGENT_ID) === undefined
      editor.update(AGENT_ID, (agent) => shapeAgent(agent as unknown as AgentFields, created))
    })
    const gate = await ctx.permission.hook("evaluate", decideEvaluation)
    const skills = await registerSkills(ctx.skill, [SKILL_PATH])
    return async () => {
      await skills.dispose()
      await gate.dispose()
      await agents.dispose()
      await tools.dispose()
    }
  },
})
