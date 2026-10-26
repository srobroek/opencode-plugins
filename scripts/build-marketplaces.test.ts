import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { drift, readPlugin, readPlugins, render, write } from "./build-marketplaces.ts"

let root: string

function plugin(name: string, manifest: Record<string, unknown>, skills: Record<string, string> = {}) {
  const dir = path.join(root, "plugins", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3", description: `${name} plugin`, ...manifest }))
  for (const [skill, body] of Object.entries(skills)) {
    mkdirSync(path.join(dir, "skills", skill), { recursive: true })
    writeFileSync(path.join(dir, "skills", skill, "SKILL.md"), body)
  }
  return dir
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\n\n# ${name}\n`

function read(file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"))
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "marketplaces-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("readPlugin", () => {
  test("exports a plugin with skills to both harnesses by default", () => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    expect(readPlugin(dir)).toEqual({
      name: "alpha",
      version: "1.2.3",
      description: "alpha plugin",
      category: "development",
      skills: ["one"],
      mcp: false,
      targets: ["claude", "codex"],
    })
  })

  test("skips a plugin with only OpenCode code", () => {
    expect(readPlugin(plugin("code-only", {}))?.targets).toEqual([])
  })

  test("honours per-harness overrides, category and description", () => {
    const dir = plugin(
      "beta",
      { "opencode-plugins": { codex: false, category: "productivity", description: "Skills only." } },
      { one: skill("one") },
    )
    expect(readPlugin(dir)).toMatchObject({ targets: ["claude"], category: "productivity", description: "Skills only." })
  })

  test("exports a plugin that only ships .mcp.json", () => {
    const dir = plugin("mcp-only", {})
    writeFileSync(path.join(dir, ".mcp.json"), "{}")
    expect(readPlugin(dir)).toMatchObject({ mcp: true, targets: ["claude", "codex"] })
  })

  test("rejects an opt-in without portable content", () => {
    const dir = plugin("empty", { "opencode-plugins": { claude: true } })
    expect(() => readPlugin(dir)).toThrow("no skills/ or .mcp.json")
  })

  test("rejects unknown config keys", () => {
    const dir = plugin("typo", { "opencode-plugins": { claud: true } }, { one: skill("one") })
    expect(() => readPlugin(dir)).toThrow('unknown "opencode-plugins" key "claud"')
  })

  test("rejects a skill whose frontmatter name differs from its directory", () => {
    const dir = plugin("gamma", {}, { one: skill("two") })
    expect(() => readPlugin(dir)).toThrow('frontmatter name "two" must match')
  })

  test("rejects a skill without a description", () => {
    const dir = plugin("delta", {}, { one: "---\nname: one\n---\n" })
    expect(() => readPlugin(dir)).toThrow("needs a description")
  })
})

describe("render and write", () => {
  test("writes both marketplaces and per-plugin manifests for exported plugins only", () => {
    plugin("alpha", {}, { one: skill("one") })
    plugin("beta", { "opencode-plugins": { codex: false } }, { two: skill("two") })
    plugin("code-only", {})
    write(root, render(root, readPlugins(root)))

    expect(read(".claude-plugin/marketplace.json")).toMatchObject({
      name: "srobroek-opencode",
      owner: { name: "Sjors Robroek" },
      plugins: [
        { name: "alpha", source: "./plugins/alpha", version: "1.2.3", category: "development" },
        { name: "beta", source: "./plugins/beta", version: "1.2.3" },
      ],
    })
    expect(read(".agents/plugins/marketplace.json")).toMatchObject({
      name: "srobroek-opencode",
      plugins: [
        {
          name: "alpha",
          source: { source: "local", path: "./plugins/alpha" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "development",
        },
      ],
    })
    expect(read("plugins/alpha/.claude-plugin/plugin.json")).toMatchObject({ name: "alpha", version: "1.2.3" })
    expect(read("plugins/alpha/.codex-plugin/plugin.json")).toMatchObject({
      name: "alpha",
      version: "1.2.3",
      skills: "./skills/",
      interface: { displayName: "Alpha", developerName: "Sjors Robroek" },
    })
    expect(existsSync(path.join(root, "plugins/beta/.codex-plugin"))).toBe(false)
    expect(existsSync(path.join(root, "plugins/code-only/.claude-plugin"))).toBe(false)
  })

  test("points Codex at a bundled .mcp.json", () => {
    const dir = plugin("mcp-only", {})
    writeFileSync(path.join(dir, ".mcp.json"), "{}")
    write(root, render(root, readPlugins(root)))
    const manifest = read("plugins/mcp-only/.codex-plugin/plugin.json") as Record<string, unknown>
    expect(manifest.mcpServers).toBe("./.mcp.json")
    expect(manifest.skills).toBeUndefined()
  })

  test("drift reports a version bump and removes manifests of plugins that opted out", () => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    write(root, render(root, readPlugins(root)))
    expect(drift(root, render(root, readPlugins(root)))).toEqual({ changed: [], extra: [] })

    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ version: "1.3.0", description: "alpha plugin", "opencode-plugins": { codex: false } }),
    )
    const outputs = render(root, readPlugins(root))
    const { changed, extra } = drift(root, outputs)
    expect(changed.map((file) => path.relative(root, file)).sort()).toEqual([
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      "plugins/alpha/.claude-plugin/plugin.json",
    ])
    expect(extra.map((file) => path.relative(root, file))).toEqual(["plugins/alpha/.codex-plugin/plugin.json"])

    write(root, outputs)
    expect(drift(root, render(root, readPlugins(root)))).toEqual({ changed: [], extra: [] })
    expect(existsSync(path.join(dir, ".codex-plugin"))).toBe(false)
  })
})
