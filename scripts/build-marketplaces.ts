// Generates the Claude Code and Codex plugin marketplaces from plugins/*.
//
// Both harnesses get the harness-neutral content: Agent Skills under skills/ and an
// optional .mcp.json. OpenCode code (src/, TUI) does not run in either harness. A
// plugin is exported when it has skills/ or .mcp.json, unless its package.json
// overrides that:
//
//   "opencode-plugins": { "claude": false, "codex": false, "category": "...", "description": "...",
//                         "claudeAgents": ["<agent id>", ...] }
//
// Claude Code also gets, per exported plugin:
//   - subagents: each agent in agents/ is translated by scripts/claude-agents.ts into
//     claude-agents/<id>.md, and the manifest lists exactly those files, because Claude
//     Code would otherwise load the OpenCode files in agents/ and ignore their
//     permissions. "claudeAgents" picks the agents (default: every non-primary one); a
//     plugin with agents/ always gets an explicit list, possibly empty. An agent id may
//     appear in only one Claude-exported plugin.
//   - hooks: hooks/claude-hooks.json, when present, and for an agent whose OpenCode rules ask
//     before some resources, claude-agents/agent-guard-hooks.json: a PreToolUse hook
//     (scripts/claude-agent-guard.ts) that asks for it, because a plugin subagent's own
//     `hooks:` are ignored by Claude Code.
//   - dependencies: the plugin's "requires" list; each one must be exported to Claude Code.
//
// "scope" and "signals" feed scripts/build-plugin-table.ts and are ignored here.
//
// Outputs (all generated, never hand-edited):
//   .claude-plugin/marketplace.json            Claude Code marketplace
//   .agents/plugins/marketplace.json           Codex marketplace
//   plugins/<name>/.claude-plugin/plugin.json  Claude Code plugin manifest
//   plugins/<name>/claude-agents/<id>.md       Claude Code subagents
//   plugins/<name>/.codex-plugin/plugin.json   Codex plugin manifest
//
//   bun scripts/build-marketplaces.ts          write all files
//   bun scripts/build-marketplaces.ts --check  fail when committed files are stale

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type Guard, translateAgent } from "./claude-agents.ts"
import { parseFrontmatter } from "./convert-agent.ts"

export const TARGETS = ["claude", "codex"] as const
export type Target = (typeof TARGETS)[number]

export type Output = { file: string; contents: string }

export type Plugin = {
  name: string
  version: string
  description: string
  category: string
  skills: string[]
  mcp: boolean
  targets: Target[]
  /** Agent ids translated for Claude Code; `undefined` when the plugin has no agents/. */
  claudeAgents?: string[]
  /** Whether hooks/claude-hooks.json exists. */
  claudeHooks: boolean
  /** Plugins this one needs, from "requires". */
  requires: string[]
}

const OWNER = { name: "Sjors Robroek", url: "https://github.com/srobroek" }
const REPOSITORY = "https://github.com/srobroek/opencode-plugins"
const MARKETPLACE = "srobroek-opencode"
const MARKETPLACE_DESCRIPTION = "Agent Skills from srobroek/opencode-plugins that also work outside OpenCode."
const LICENSE = "Apache-2.0"
const DEFAULT_CATEGORY = "development"
const CONFIG_KEY = "opencode-plugins"
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const MANIFEST_DIRS: Record<Target, string> = { claude: ".claude-plugin", codex: ".codex-plugin" }
const CLAUDE_AGENTS_DIR = "claude-agents"
const CLAUDE_HOOKS = "hooks/claude-hooks.json"
const GUARD_SCRIPT = "agent-guard.mjs"
const GUARD_CONFIG = "agent-guards.json"
const GUARD_HOOKS = "agent-guard-hooks.json"

type Config = {
  claude?: boolean
  codex?: boolean
  category?: string
  description?: string
  claudeAgents?: string[]
  requires?: string[]
}

const CONFIG_KEYS = ["claude", "codex", "category", "description", "claudeAgents", "scope", "signals", "requires"]

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

function parseConfig(where: string, value: unknown): Config {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(where, `"${CONFIG_KEY}" must be an object`)
  const config = value as Record<string, unknown>
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) fail(where, `unknown "${CONFIG_KEY}" key "${key}"`)
  }
  for (const key of ["claudeAgents", "requires"]) {
    const field = config[key]
    if (field !== undefined && (!Array.isArray(field) || !field.every((item) => typeof item === "string" && item !== "")))
      fail(where, `"${CONFIG_KEY}.${key}" must be a list of names`)
  }
  for (const key of TARGETS) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") fail(where, `"${CONFIG_KEY}.${key}" must be a boolean`)
  }
  for (const key of ["category", "description"]) {
    const field = config[key]
    if (field !== undefined && (typeof field !== "string" || !field.trim())) {
      fail(where, `"${CONFIG_KEY}.${key}" must be a non-empty string`)
    }
  }
  return config as Config
}

/** The skill directories under skills/, each checked for a SKILL.md whose frontmatter names it. */
export function readSkills(dir: string): string[] {
  const skillsDir = path.join(dir, "skills")
  if (!existsSync(skillsDir)) return []
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const name of names) {
    const where = path.join(path.basename(dir), "skills", name, "SKILL.md")
    const file = path.join(skillsDir, name, "SKILL.md")
    if (!existsSync(file)) fail(where, "missing")
    const frontmatter = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1]
    if (!frontmatter) fail(where, "missing YAML frontmatter")
    const declared = frontmatter.match(/^name:\s*(.+?)\s*$/m)?.[1]
    if (declared !== name) fail(where, `frontmatter name "${declared ?? ""}" must match the directory name "${name}"`)
    if (!/^description:\s*\S/m.test(frontmatter)) fail(where, "frontmatter needs a description")
  }
  return names
}

/** The OpenCode agent ids in agents/ and which of them are primary, or undefined without agents/. */
export function readAgents(dir: string): { id: string; primary: boolean }[] | undefined {
  const agentsDir = path.join(dir, "agents")
  if (!existsSync(agentsDir)) return undefined
  return readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      id: name.slice(0, -3),
      primary: parseFrontmatter(readFileSync(path.join(agentsDir, name), "utf8")).data.mode === "primary",
    }))
}

function claudeAgentIds(where: string, dir: string, selected: string[] | undefined): string[] | undefined {
  const agents = readAgents(dir)
  if (agents === undefined) {
    if (selected !== undefined) fail(where, `"${CONFIG_KEY}.claudeAgents" is set but there is no agents/`)
    return undefined
  }
  if (selected === undefined) return agents.filter((agent) => !agent.primary).map((agent) => agent.id)
  for (const id of selected) {
    const agent = agents.find((candidate) => candidate.id === id)
    if (agent === undefined) fail(where, `"${CONFIG_KEY}.claudeAgents" names "${id}", which is not in agents/`)
    if (agent.primary) fail(where, `"${CONFIG_KEY}.claudeAgents" names the primary agent "${id}"`)
  }
  return [...new Set(selected)].sort()
}

/** The marketplace view of one plugin directory, or undefined when it has no package.json. */
export function readPlugin(dir: string): Plugin | undefined {
  const manifestPath = path.join(dir, "package.json")
  if (!existsSync(manifestPath)) return undefined
  const name = path.basename(dir)
  const where = `plugins/${name}/package.json`
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  const config = parseConfig(where, manifest[CONFIG_KEY])
  const skills = readSkills(dir)
  const mcp = existsSync(path.join(dir, ".mcp.json"))
  const portable = skills.length > 0 || mcp
  const targets = TARGETS.filter((target) => config[target] ?? portable)
  if (targets.length > 0 && !portable) fail(where, `"${CONFIG_KEY}" exports ${targets.join(", ")} but there is no skills/ or .mcp.json`)
  if (targets.length > 0 && !NAME_PATTERN.test(name)) fail(where, `directory name "${name}" is not a valid plugin name`)
  const version = manifest.version
  if (typeof version !== "string" || !version) fail(where, "version must be a non-empty string")
  const description = config.description ?? manifest.description
  if (typeof description !== "string" || !description.trim()) fail(where, "description must be a non-empty string")
  const claudeAgents = claudeAgentIds(where, dir, config.claudeAgents)
  return {
    name,
    version,
    description,
    category: config.category ?? DEFAULT_CATEGORY,
    skills,
    mcp,
    targets,
    ...(claudeAgents === undefined ? {} : { claudeAgents }),
    claudeHooks: existsSync(path.join(dir, CLAUDE_HOOKS)),
    requires: config.requires ?? [],
  }
}

export function readPlugins(root: string): Plugin[] {
  const pluginsDir = path.join(root, "plugins")
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => readPlugin(path.join(pluginsDir, name)) ?? [])
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function metadata(plugin: Plugin) {
  return {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: { name: OWNER.name, url: OWNER.url },
    homepage: `${REPOSITORY}/tree/main/plugins/${plugin.name}`,
    repository: REPOSITORY,
    license: LICENSE,
  }
}

function displayName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function claudeMarketplace(plugins: Plugin[]) {
  return {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: MARKETPLACE,
    description: MARKETPLACE_DESCRIPTION,
    owner: OWNER,
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      source: `./plugins/${plugin.name}`,
      description: plugin.description,
      version: plugin.version,
      category: plugin.category,
    })),
  }
}

function codexMarketplace(plugins: Plugin[]) {
  return {
    name: MARKETPLACE,
    interface: { displayName: "srobroek opencode-plugins" },
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      source: { source: "local", path: `./plugins/${plugin.name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: plugin.category,
    })),
  }
}

function codexManifest(plugin: Plugin) {
  return {
    ...metadata(plugin),
    ...(plugin.skills.length > 0 ? { skills: "./skills/" } : {}),
    ...(plugin.mcp ? { mcpServers: "./.mcp.json" } : {}),
    interface: {
      displayName: displayName(plugin.name),
      shortDescription: plugin.description,
      developerName: OWNER.name,
      category: plugin.category,
    },
  }
}

function claudeManifest(plugin: Plugin, guarded: boolean) {
  const hooks = [...(plugin.claudeHooks ? [`./${CLAUDE_HOOKS}`] : []), ...(guarded ? [`./${CLAUDE_AGENTS_DIR}/${GUARD_HOOKS}`] : [])]
  return {
    ...metadata(plugin),
    ...(plugin.claudeAgents === undefined
      ? {}
      : { agents: plugin.claudeAgents.map((id) => `./${CLAUDE_AGENTS_DIR}/${id}.md`) }),
    ...(hooks.length > 0 ? { hooks: hooks.length === 1 ? hooks[0] : hooks } : {}),
    ...(plugin.requires.length > 0 ? { dependencies: plugin.requires } : {}),
  }
}

/** Refuse Claude Code output that would not load as intended: a missing dependency or a duplicate agent id. */
function checkClaude(plugins: readonly Plugin[]): void {
  const exported = plugins.filter((plugin) => plugin.targets.includes("claude"))
  const names = new Set(exported.map((plugin) => plugin.name))
  const owners = new Map<string, string>()
  for (const plugin of exported) {
    const where = `plugins/${plugin.name}/package.json`
    for (const dependency of plugin.requires)
      if (!names.has(dependency)) fail(where, `requires "${dependency}", which is not exported to Claude Code`)
    for (const id of plugin.claudeAgents ?? []) {
      const owner = owners.get(id)
      if (owner !== undefined)
        fail(where, `agent "${id}" is also exported to Claude Code by ${owner}; set "${CONFIG_KEY}.claudeAgents" in one of them`)
      owners.set(id, plugin.name)
    }
  }
}

const GUARD_SOURCE = path.join(import.meta.dir, "claude-agent-guard.ts")

/** The source's Bun-only entry check; the shipped script calls `main()` unconditionally instead. */
const GUARD_ENTRY = "if (import.meta.main) main()"

/** The command of the guard hook: node or bun runs it, and with neither every guarded call asks. */
const GUARD_FALLBACK =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"agent guard needs node or bun; asking instead"}}'
const GUARD_COMMAND =
  `R="\${CLAUDE_PLUGIN_ROOT}/${CLAUDE_AGENTS_DIR}/${GUARD_SCRIPT}"; ` +
  `if command -v node >/dev/null 2>&1; then node "$R"; elif command -v bun >/dev/null 2>&1; then bun "$R"; ` +
  `else printf '%s' '${GUARD_FALLBACK}'; fi; exit 0`

/** The hook, its script and the guard rules for the agents of one plugin. */
function guardOutputs(agentsDir: string, guards: Record<string, Guard[]>): Output[] {
  const tools = [...new Set(Object.values(guards).flatMap((list) => list.flatMap((guard) => guard.tools)))]
  const source = readFileSync(GUARD_SOURCE, "utf8")
  if (source.split(GUARD_ENTRY).length !== 2) fail(GUARD_SOURCE, `needs exactly one "${GUARD_ENTRY}" line`)
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(GUARD_ENTRY, "main()"))
  const hooks = {
    description: "Asks before a subagent touches a resource its OpenCode rules ask about; Claude Code ignores subagent hooks of plugins.",
    hooks: { PreToolUse: [{ matcher: tools.join("|"), hooks: [{ type: "command", command: GUARD_COMMAND, timeout: 10 }] }] },
  }
  return [
    { file: path.join(agentsDir, GUARD_SCRIPT), contents: script },
    { file: path.join(agentsDir, GUARD_CONFIG), contents: json(guards) },
    { file: path.join(agentsDir, GUARD_HOOKS), contents: json(hooks) },
  ]
}

/** Every generated file, keyed by absolute path, for the given plugins. Translation warnings go to `warn`. */
export function render(root: string, plugins: Plugin[], warn: (message: string) => void = () => {}): Output[] {
  checkClaude(plugins)
  const forTarget = (target: Target) => plugins.filter((plugin) => plugin.targets.includes(target))
  const outputs: Output[] = [
    { file: path.join(root, ".claude-plugin", "marketplace.json"), contents: json(claudeMarketplace(forTarget("claude"))) },
    { file: path.join(root, ".agents", "plugins", "marketplace.json"), contents: json(codexMarketplace(forTarget("codex"))) },
  ]
  for (const plugin of plugins) {
    const dir = path.join(root, "plugins", plugin.name)
    if (plugin.targets.includes("claude")) {
      const guards: Record<string, Guard[]> = {}
      const agentOutputs: Output[] = []
      for (const id of plugin.claudeAgents ?? []) {
        const source = path.join(dir, "agents", `${id}.md`)
        const agent = translateAgent(id, readFileSync(source, "utf8"), `plugins/${plugin.name}/agents/${id}.md`)
        const reasons = Map.groupBy(agent.dropped, (drop) => drop.reason)
        for (const [reason, drops] of reasons)
          warn(`${plugin.name}/${id}: ${reason}: ${drops.map((drop) => drop.rule).join(", ")}`)
        if (agent.guards.length > 0) guards[id] = agent.guards
        agentOutputs.push({ file: path.join(dir, CLAUDE_AGENTS_DIR, `${id}.md`), contents: agent.contents })
      }
      const guarded = Object.keys(guards).length > 0
      outputs.push({ file: path.join(dir, MANIFEST_DIRS.claude, "plugin.json"), contents: json(claudeManifest(plugin, guarded)) })
      outputs.push(...agentOutputs)
      if (guarded) outputs.push(...guardOutputs(path.join(dir, CLAUDE_AGENTS_DIR), guards))
    }
    if (plugin.targets.includes("codex")) {
      outputs.push({ file: path.join(dir, MANIFEST_DIRS.codex, "plugin.json"), contents: json(codexManifest(plugin)) })
    }
  }
  return outputs
}

/** Plugin manifests and Claude Code agents on disk. Every one of them is generated, so any not in a fresh render is stale. */
export function existingManifests(root: string): string[] {
  const pluginsDir = path.join(root, "plugins")
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(pluginsDir, entry.name)
      const agentsDir = path.join(dir, CLAUDE_AGENTS_DIR)
      const agents = existsSync(agentsDir) ? readdirSync(agentsDir).map((name) => path.join(agentsDir, name)) : []
      return [...TARGETS.map((target) => path.join(dir, MANIFEST_DIRS[target], "plugin.json")), ...agents]
    })
    .filter(existsSync)
}

export type Drift = { changed: string[]; extra: string[] }

export function drift(root: string, outputs: readonly Output[]): Drift {
  const expected = new Set(outputs.map((output) => output.file))
  return {
    changed: outputs
      .filter((output) => !existsSync(output.file) || readFileSync(output.file, "utf8") !== output.contents)
      .map((output) => output.file),
    extra: existingManifests(root).filter((file) => !expected.has(file)),
  }
}

export function write(root: string, outputs: readonly Output[]): void {
  const { extra } = drift(root, outputs)
  for (const file of extra) {
    rmSync(file)
    const dir = path.dirname(file)
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
  }
  for (const output of outputs) {
    mkdirSync(path.dirname(output.file), { recursive: true })
    writeFileSync(output.file, output.contents)
  }
}

function main(check: boolean) {
  const root = path.resolve(import.meta.dir, "..")
  const plugins = readPlugins(root)
  const warnings: string[] = []
  const outputs = render(root, plugins, (message) => warnings.push(message))
  if (check) {
    const { changed, extra } = drift(root, outputs)
    const stale = [...changed, ...extra]
    if (stale.length > 0) {
      console.error("Marketplace files are stale. Run `bun run marketplaces` and commit the result:")
      for (const file of stale) console.error(`  ${path.relative(root, file)}`)
      process.exit(1)
    }
    return
  }
  write(root, outputs)
  for (const plugin of plugins) {
    console.log(`${plugin.name}: ${plugin.targets.length > 0 ? plugin.targets.join(", ") : "skipped"}`)
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`)
}

if (import.meta.main) main(process.argv.includes("--check"))
