import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { agentPaths } from "./agent-files.ts"
import { MCP_EXCLUDED_AGENTS, MCP_TOOL_AGENTS, refusedTool } from "./agent-tools.ts"
import { createFakeContext } from "./testing.ts"

const PLUGINS = join(import.meta.dir, "../..")
const sources = (plugin: string) => {
  const dir = join(PLUGINS, plugin, "src")
  try {
    return readdirSync(dir)
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => readFileSync(join(dir, file), "utf8"))
  } catch {
    return []
  }
}

/** Tool names a plugin's source names: `*_TOOL`/`*_ACTION` constants and `name: "x_y"` literals. */
function sourceToolNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\b[A-Z_]*(?:TOOL|ACTION|TOOL_NAME)\s*=\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g))
    names.add(match[1] as string)
  for (const match of text.matchAll(/\bname:\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g)) names.add(match[1] as string)
  return [...names]
}

/** Tool names a plugin registers when set up against a fake host; plugins needing more host surface are skipped. */
async function registeredToolNames(plugin: string): Promise<string[]> {
  try {
    const mod = (await import(join(PLUGINS, plugin, "src/index.ts"))).default as {
      setup: (ctx: unknown) => Promise<(() => unknown) | undefined>
    }
    const fake = createFakeContext()
    const cleanup = await mod.setup(fake.context)
    const names = [...fake.tools.keys()]
    await cleanup?.()
    return names
  } catch {
    return []
  }
}

describe("tools option refuses every tool a plugin in this repository registers", () => {
  const plugins = readdirSync(PLUGINS).filter((name) => name !== "lib")

  test("the scan finds the tools it should", () => {
    const found = plugins.flatMap((plugin) => sources(plugin).flatMap(sourceToolNames))
    for (const name of ["dep_apply", "delivery_land", "quality_test_summarize", "parley_ask", "model_roles_check", "find_tools_scan"])
      expect(found).toContain(name)
  })

  test.each(plugins)("%s", async (plugin) => {
    const names = new Set([...sources(plugin).flatMap(sourceToolNames), ...(await registeredToolNames(plugin))])
    for (const name of names) {
      expect(refusedTool(name), `exact name ${name}`).toBeDefined()
      expect(refusedTool(`${name.split("_")[0]}_*`), `namespace of ${name}`).toBeDefined()
    }
  })
})

describe("MCP grant sets", () => {
  // Vendored agents (cad) follow their own source, so they are not part of the grant sets.
  const VENDORED = ["cad"]
  // Read the first rule as text: delivery's agents carry a `model` key that the shared parser refuses.
  const DENY_ALL_FIRST = /^permissions:\n {2}- action: "\*"\n {4}resource: "\*"\n {4}effect: deny$/m
  const shipped = readdirSync(PLUGINS)
    .filter((name) => name !== "lib" && !VENDORED.includes(name))
    .flatMap((plugin) =>
      agentPaths(join(PLUGINS, plugin, "agents")).map((path) => ({
        id: basename(path, ".md"),
        denyAll: DENY_ALL_FIRST.test(readFileSync(path, "utf8")),
      })),
    )
  const shippedIds = new Set(shipped.map((agent) => agent.id))

  test("every id in either set ships in a plugin, or is OpenCode's built-in explore", () => {
    const unknown = [...MCP_TOOL_AGENTS, ...MCP_EXCLUDED_AGENTS].filter((id) => id !== "explore" && !shippedIds.has(id))
    expect(unknown).toEqual([])
  })

  test("the grant set and the excluded set do not overlap", () => {
    expect([...MCP_TOOL_AGENTS].filter((id) => MCP_EXCLUDED_AGENTS.has(id))).toEqual([])
  })

  test("every shipped agent that denies all tools first sits in exactly one set", () => {
    const denyAll = shipped.filter((agent) => agent.denyAll).map((agent) => agent.id)
    expect(denyAll.length).toBeGreaterThan(0)
    const unplaced = denyAll.filter((id) => Number(MCP_TOOL_AGENTS.has(id)) + Number(MCP_EXCLUDED_AGENTS.has(id)) !== 1)
    expect(unplaced).toEqual([])
  })
})

describe("OpenCode's own tool namespaces", () => {
  test.each(["opencode_*", "opencode_artifact_read", "tui_*", "sniff_*", "lsp_*", "subagent_*"])("refuses %s", (pattern) => {
    expect(refusedTool(pattern)).toBeDefined()
  })
})
