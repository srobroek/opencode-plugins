// Generates the Claude Code and Codex plugin marketplaces from plugins/*.
//
// Only harness-neutral content is exported: Agent Skills under skills/ and an
// optional .mcp.json. OpenCode code (src/, dist/, TUI) does not run in either
// harness. A plugin is exported when it has skills/ or .mcp.json, unless its
// package.json overrides that:
//
//   "opencode-plugins": { "claude": false, "codex": false, "category": "...", "description": "..." }
//
// Outputs (all generated, never hand-edited):
//   .claude-plugin/marketplace.json            Claude Code marketplace
//   .agents/plugins/marketplace.json           Codex marketplace
//   plugins/<name>/.claude-plugin/plugin.json  Claude Code plugin manifest
//   plugins/<name>/.codex-plugin/plugin.json   Codex plugin manifest
//
//   bun scripts/build-marketplaces.ts          write all files
//   bun scripts/build-marketplaces.ts --check  fail when committed files are stale

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

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

type Config = { claude?: boolean; codex?: boolean; category?: string; description?: string }

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

function parseConfig(where: string, value: unknown): Config {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(where, `"${CONFIG_KEY}" must be an object`)
  const config = value as Record<string, unknown>
  for (const key of Object.keys(config)) {
    if (!["claude", "codex", "category", "description"].includes(key)) fail(where, `unknown "${CONFIG_KEY}" key "${key}"`)
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
  return { name, version, description, category: config.category ?? DEFAULT_CATEGORY, skills, mcp, targets }
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

/** Every generated file, keyed by absolute path, for the given plugins. */
export function render(root: string, plugins: Plugin[]): Output[] {
  const forTarget = (target: Target) => plugins.filter((plugin) => plugin.targets.includes(target))
  const outputs: Output[] = [
    { file: path.join(root, ".claude-plugin", "marketplace.json"), contents: json(claudeMarketplace(forTarget("claude"))) },
    { file: path.join(root, ".agents", "plugins", "marketplace.json"), contents: json(codexMarketplace(forTarget("codex"))) },
  ]
  for (const plugin of plugins) {
    const dir = path.join(root, "plugins", plugin.name)
    if (plugin.targets.includes("claude")) {
      outputs.push({ file: path.join(dir, MANIFEST_DIRS.claude, "plugin.json"), contents: json(metadata(plugin)) })
    }
    if (plugin.targets.includes("codex")) {
      outputs.push({ file: path.join(dir, MANIFEST_DIRS.codex, "plugin.json"), contents: json(codexManifest(plugin)) })
    }
  }
  return outputs
}

/** Plugin manifests on disk. Every one of them is generated, so any not in a fresh render is stale. */
export function existingManifests(root: string): string[] {
  const pluginsDir = path.join(root, "plugins")
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => TARGETS.map((target) => path.join(pluginsDir, entry.name, MANIFEST_DIRS[target], "plugin.json")))
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
  const outputs = render(root, plugins)
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
}

if (import.meta.main) main(process.argv.includes("--check"))
