import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { drift, readPlugin, readPlugins, render, write } from "./build-marketplaces.ts"

let root: string

/**
 * The guard tests start Bun or Node. Measured: a hook subprocess test runs in about 0.2 s alone
 * and passed the 5 s default under a full `bun run check`.
 */
const SPAWN_MS = 30_000

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
      claudeHooks: false,
      requires: [],
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
  test("accepts plugin-table keys and renders the same output without them", () => {
    plugin("alpha", { "opencode-plugins": { scope: "project", signals: ["x/"] } }, { one: skill("one") })
    plugin("beta", { "opencode-plugins": { scope: "global" } }, { two: skill("two") })
    const withKeys = render(root, readPlugins(root))
    plugin("alpha", {}, { one: skill("one") })
    plugin("beta", {}, { two: skill("two") })
    expect(render(root, readPlugins(root))).toEqual(withKeys)
  })

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

const openCodeAgent = (mode: string, tools: string[]) =>
  `---\ndescription: "An agent."\nmode: ${mode}\nsteps: 40\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: deny\n${tools
    .map((tool) => `  - action: ${tool}\n    resource: "*"\n    effect: allow\n`)
    .join("")}---\n\nPrompt.\n`

function agents(dir: string, files: Record<string, string>) {
  mkdirSync(path.join(dir, "agents"), { recursive: true })
  for (const [id, text] of Object.entries(files)) writeFileSync(path.join(dir, "agents", `${id}.md`), text)
}

describe("Claude Code components", () => {
  test("translates every non-primary agent and lists exactly those files in the manifest", () => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    agents(dir, { lead: openCodeAgent("primary", ["read"]), reader: openCodeAgent("subagent", ["read", "grep"]) })
    write(root, render(root, readPlugins(root)))
    expect(read("plugins/alpha/.claude-plugin/plugin.json")).toMatchObject({ agents: ["./claude-agents/reader.md"] })
    expect(readFileSync(path.join(dir, "claude-agents/reader.md"), "utf8")).toContain("\ntools: Read, Grep\nmaxTurns: 40\n")
    expect(existsSync(path.join(dir, "claude-agents/lead.md"))).toBe(false)
    expect(read("plugins/alpha/.codex-plugin/plugin.json")).not.toHaveProperty("agents")
  })

  test("an empty claudeAgents list still sets agents, so Claude Code skips the OpenCode files", () => {
    const dir = plugin("alpha", { "opencode-plugins": { claudeAgents: [] } }, { one: skill("one") })
    agents(dir, { reader: openCodeAgent("subagent", ["read"]) })
    write(root, render(root, readPlugins(root)))
    expect(read("plugins/alpha/.claude-plugin/plugin.json")).toMatchObject({ agents: [] })
  })

  test("a plugin without agents/ gets no agents key", () => {
    plugin("alpha", {}, { one: skill("one") })
    write(root, render(root, readPlugins(root)))
    expect(read("plugins/alpha/.claude-plugin/plugin.json")).not.toHaveProperty("agents")
  })

  test.each([
    ["an agent that is not in agents/", { claudeAgents: ["missing"] }, 'names "missing", which is not in agents/'],
    ["a primary agent", { claudeAgents: ["lead"] }, 'names the primary agent "lead"'],
  ])("rejects claudeAgents naming %s", (_, config, message) => {
    const dir = plugin("alpha", { "opencode-plugins": config }, { one: skill("one") })
    agents(dir, { lead: openCodeAgent("primary", ["read"]) })
    expect(() => readPlugin(dir)).toThrow(message)
  })

  test("refuses the same agent id in two Claude-exported plugins", () => {
    agents(plugin("alpha", {}, { one: skill("one") }), { reader: openCodeAgent("subagent", ["read"]) })
    agents(plugin("beta", {}, { two: skill("two") }), { reader: openCodeAgent("subagent", ["read"]) })
    expect(() => render(root, readPlugins(root))).toThrow('agent "reader" is also exported to Claude Code by alpha')
  })

  test("references hooks/claude-hooks.json and maps requires to dependencies", () => {
    const dir = plugin("alpha", { "opencode-plugins": { requires: ["beta"] } }, { one: skill("one") })
    plugin("beta", {}, { two: skill("two") })
    mkdirSync(path.join(dir, "hooks"))
    writeFileSync(path.join(dir, "hooks/claude-hooks.json"), "{}")
    write(root, render(root, readPlugins(root)))
    expect(read("plugins/alpha/.claude-plugin/plugin.json")).toMatchObject({
      hooks: "./hooks/claude-hooks.json",
      dependencies: ["beta"],
    })
    expect(read("plugins/alpha/.codex-plugin/plugin.json")).not.toHaveProperty("dependencies")
  })

  const guardedAgent = openCodeAgent("subagent", ["read"]).replace(
    "---\n\nPrompt.",
    '  - action: read\n    resource: "*.env"\n    effect: ask\n---\n\nPrompt.',
  )

  test("ships a PreToolUse guard for an agent with a restricted ask and lists its hooks", () => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    agents(dir, { reader: guardedAgent, plain: openCodeAgent("subagent", ["read"]) })
    write(root, render(root, readPlugins(root)))
    expect(read("plugins/alpha/claude-agents/agent-guards.json")).toEqual({
      reader: [{ tools: ["Read"], rules: [{ resource: "*.env", effect: "ask" }] }],
    })
    expect(readFileSync(path.join(dir, "claude-agents/agent-guard.mjs"), "utf8")).toContain("guardDecision")
    const hooks = read("plugins/alpha/claude-agents/agent-guard-hooks.json") as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
    }
    expect(hooks.hooks.PreToolUse[0]?.matcher).toBe("Read")
    expect(hooks.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("$" + "{CLAUDE_PLUGIN_ROOT}/claude-agents/agent-guard.mjs")
    expect(read("plugins/alpha/.claude-plugin/plugin.json")).toMatchObject({ hooks: "./claude-agents/agent-guard-hooks.json" })
  })

  test("lists the guard hooks after the plugin's own hooks", () => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    agents(dir, { reader: guardedAgent })
    mkdirSync(path.join(dir, "hooks"))
    writeFileSync(path.join(dir, "hooks/claude-hooks.json"), "{}")
    write(root, render(root, readPlugins(root)))
    expect(read("plugins/alpha/.claude-plugin/plugin.json")).toMatchObject({
      hooks: ["./hooks/claude-hooks.json", "./claude-agents/agent-guard-hooks.json"],
    })
  })

  test("the shipped guard asks for a guarded read when run as the hook command does", async () => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    agents(dir, { reader: guardedAgent })
    write(root, render(root, readPlugins(root)))
    const proc = Bun.spawn(["bun", path.join(dir, "claude-agents/agent-guard.mjs")], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Read", agent_type: "alpha:reader", tool_input: { file_path: "/r/.env" } })),
      stdout: "pipe",
    })
    expect(JSON.parse(await new Response(proc.stdout).text()).hookSpecificOutput.permissionDecision).toBe("ask")
  }, SPAWN_MS)

  // A load hook that hides `import.meta.main` from .mjs files, as on Node before 22.18 and 24.2.
  const WITHOUT_IMPORT_META_MAIN = `data:text/javascript,import { register } from "node:module"; register(${JSON.stringify(
    'data:text/javascript,export async function load(url, context, next) { const out = await next(url, context); if (url.endsWith(".mjs")) out.source = String(out.source).replaceAll("import.meta.main", "undefined"); return out }',
  )})`

  test.each([
    ["Node", []],
    ["a Node without import.meta.main", ["--import", WITHOUT_IMPORT_META_MAIN]],
  ])("the shipped guard asks for a guarded read under %s through a symlinked plugin directory", async (_, flags) => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    agents(dir, { reader: guardedAgent })
    write(root, render(root, readPlugins(root)))
    // Claude Code may reach a plugin through a symlink, so the script path is not its real path.
    const linked = path.join(root, "linked-alpha")
    symlinkSync(dir, linked)
    const proc = Bun.spawn(["node", ...flags, path.join(linked, "claude-agents/agent-guard.mjs")], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Read", agent_type: "alpha:reader", tool_input: { file_path: "/r/.env" } })),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, code] = [await new Response(proc.stdout).text(), await proc.exited]
    expect(code).toBe(0)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("ask")
  }, SPAWN_MS)

  test("refuses a dependency that is not exported to Claude Code", () => {
    plugin("alpha", { "opencode-plugins": { requires: ["beta"] } }, { one: skill("one") })
    plugin("beta", { "opencode-plugins": { claude: false } }, { two: skill("two") })
    expect(() => render(root, readPlugins(root))).toThrow('requires "beta", which is not exported to Claude Code')
  })

  test("reports a stale translation and removes agents no longer exported", () => {
    const dir = plugin("alpha", {}, { one: skill("one") })
    agents(dir, { reader: openCodeAgent("subagent", ["read"]) })
    write(root, render(root, readPlugins(root)))
    writeFileSync(path.join(dir, "agents/reader.md"), openCodeAgent("subagent", ["read", "glob"]))
    expect(drift(root, render(root, readPlugins(root))).changed.map((file) => path.relative(root, file))).toContain(
      "plugins/alpha/claude-agents/reader.md",
    )

    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3", description: "a", "opencode-plugins": { claudeAgents: [] } }))
    const outputs = render(root, readPlugins(root))
    expect(drift(root, outputs).extra.map((file) => path.relative(root, file))).toEqual(["plugins/alpha/claude-agents/reader.md"])
    write(root, outputs)
    expect(existsSync(path.join(dir, "claude-agents"))).toBe(false)
  })
})
