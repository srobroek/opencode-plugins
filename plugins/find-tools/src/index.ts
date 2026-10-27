import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { guardInstall } from "./install-gate.ts"
import { type LocalInventory, renderScan, type ScanParams, SOURCES, scanSources } from "./scan.ts"

export { evaluationKind, guardInstall, installKind, readsStdin } from "./install-gate.ts"
export { keyTerms, npmSearchText, queryTerms, relevance } from "./query.ts"
export { defaultRun } from "./run.ts"
export {
  awesomeEntries,
  catalogEntries,
  catalogIndexUrl,
  classify,
  githubSearches,
  mcpCounts,
  registryInstall,
  renderScan,
  SOURCES,
  scanSources,
} from "./scan.ts"

export const SKILL_PATH = fileURLToPath(new URL("../skills/find-tools/SKILL.md", import.meta.url))

export type FindToolsOptions = {
  /** Ask before skills CLI, Smithery CLI and pipe-to-shell installs. */
  guardInstalls: boolean
  /** Extra skill catalog URLs the catalog source reads. */
  skillCatalogs: string[]
}

export function readOptions(options: Readonly<Record<string, unknown>>): FindToolsOptions {
  const catalogs = options.skillCatalogs
  return {
    guardInstalls: options.guardInstalls !== false,
    skillCatalogs: Array.isArray(catalogs) ? catalogs.filter((url): url is string => typeof url === "string") : [],
  }
}

type ListApi = { list: () => Promise<unknown> }

/** Wrap the host's list APIs, called with `this` bound to their domain. */
export function localInventory(ctx: { plugin?: unknown; skill?: unknown; mcp?: unknown }): LocalInventory {
  const call = (api: unknown, name: string) => async () => {
    const list = (api as Partial<ListApi> | undefined)?.list
    if (typeof list !== "function") throw new Error(`${name}.list unavailable`)
    return list.call(api)
  }
  return { plugins: call(ctx.plugin, "plugin"), skills: call(ctx.skill, "skill"), mcp: call(ctx.mcp, "mcp") }
}

export default Plugin.define({
  id: "srobroek.find-tools",
  async setup(ctx) {
    const options = readOptions(ctx.options)
    const local = localInventory(ctx)
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "find_tools_scan",
        description:
          "Read-only discovery of plugins, skills and MCP servers for a capability.\nSources run in parallel, " +
          "10 s each: local (installed plugins and skills; MCP as counts only), catalog (srobroek/opencode-plugins " +
          "marketplace and configured skill catalogs), mcp_registry, npm, github (gh api), awesome_opencode " +
          "(unvetted), smithery (needs SMITHERY_API_KEY), skills_cli (reported gap, never run). Each source " +
          "reports ok, empty, partial, skipped or failed, with gaps and coverage. Install hints are shown, never run.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "The capability to find, in a few words" },
            sources: {
              type: "array",
              items: { type: "string", enum: [...SOURCES] },
              description: "Optional subset of sources; all by default",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          try {
            const report = await scanSources(input as ScanParams, {
              signal: context.signal,
              local,
              skillCatalogs: options.skillCatalogs,
            })
            return { content: renderScan(report), metadata: { ok: true, ...report } }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { content: `find_tools_scan error: ${message}`, metadata: { ok: false, error: message } }
          }
        },
      })
    })
    const gate = options.guardInstalls ? await ctx.permission.hook("evaluate", guardInstall) : undefined
    const skills = await registerSkills(ctx.skill, [SKILL_PATH])
    return async () => {
      await skills.dispose()
      await gate?.dispose()
      await tools.dispose()
    }
  },
})
