import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { refusedTool } from "./agent-tools.ts"
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

describe("OpenCode's own tool namespaces", () => {
  test.each(["opencode_*", "opencode_artifact_read", "tui_*", "sniff_*", "lsp_*", "subagent_*"])("refuses %s", (pattern) => {
    expect(refusedTool(pattern)).toBeDefined()
  })
})
