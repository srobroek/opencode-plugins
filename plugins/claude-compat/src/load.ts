/**
 * Read Claude plugin sources into one {@link Bundle} per project, and share bundles
 * between setups of the same project and configuration. Nothing here registers anything;
 * `index.ts` adapts a bundle to the plugin context.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import type { Skill } from "@opencode/plugin"
import type { AgentFile } from "@srobroek/opencode-lib/agent-files"
import type { McpServers } from "@srobroek/opencode-lib/mcp"
import {
  type AgentSettings,
  type CommandFile,
  convertAgent,
  convertCommand,
  convertSkill,
  type Diagnostic,
  parseClaudeMcp,
  rewriteRoot,
} from "./convert.ts"
import { type HookSpec, parseHooks } from "./hooks.ts"
import { type ClaudePlugin, containedPath, discoverPlugins, type Group, inside, sourcePath } from "./source.ts"

export type Settings = AgentSettings & { hooks: boolean; instructions: boolean }

export type Bundle = {
  project: string
  plugins: { name: string; root: string }[]
  skills: Skill.Info[]
  agents: AgentFile[]
  commands: (CommandFile & { plugin: string })[]
  mcp: { plugin: string; root: string; servers: McpServers }[]
  hooks: HookSpec[]
  /** Plugin-provided CLAUDE.md text, when `instructions` is on. */
  instructions: { plugin: string; text: string }[]
  diagnostics: Diagnostic[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Manifest component paths (string or list) and the default directory, each canonical and
 * inside the plugin root; defaults first. Escapes are reported and skipped.
 */
function componentPaths(plugin: ClaudePlugin, key: string, fallback: string, diagnostics: Diagnostic[]): string[] {
  const value = plugin.manifest[key]
  const extra = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
  const paths: string[] = []
  for (const path of [fallback, ...extra]) {
    try {
      const real = containedPath(plugin.root, path)
      if (real !== undefined) paths.push(real)
    } catch (error) {
      diagnostics.push({ where: `${plugin.name}: ${path === fallback ? key : `manifest ${key}`}`, message: String(error) })
    }
  }
  return [...new Set(paths)]
}

/** Canonical entries of `dir` (a canonical directory inside `root`); escaping symlinks are reported. */
function entries(root: string, dir: string, diagnostics: Diagnostic[]): { name: string; real: string; directory: boolean }[] {
  const found: { name: string; real: string; directory: boolean }[] = []
  for (const name of readdirSync(dir).sort()) {
    try {
      const real = containedPath(root, join(dir, name))
      if (real !== undefined) found.push({ name, real, directory: statSync(real).isDirectory() })
    } catch (error) {
      diagnostics.push({ where: join(dir, name), message: String(error) })
    }
  }
  return found
}

/** `SKILL.md` files of a skills directory (or of one skill directory), canonical and inside `root`. */
function skillFiles(root: string, dir: string, diagnostics: Diagnostic[]): string[] {
  if (!statSync(dir).isDirectory()) return []
  const children = entries(root, dir, diagnostics)
  const own = children.find((entry) => entry.name === "SKILL.md" && !entry.directory)
  if (own) return [own.real]
  return children
    .filter((entry) => entry.directory)
    .flatMap((entry) => entries(root, entry.real, diagnostics).filter((file) => file.name === "SKILL.md" && !file.directory))
    .map((file) => file.real)
}

/**
 * Markdown files under `path` (a file or a directory, recursively, four levels), canonical
 * and inside `root`, named by their path relative to `path`.
 */
function markdownFiles(root: string, path: string, diagnostics: Diagnostic[]): { file: string; name: string }[] {
  if (!statSync(path).isDirectory()) return path.endsWith(".md") ? [{ file: path, name: basename(path, ".md") }] : []
  const found: { file: string; name: string }[] = []
  const seen = new Set<string>()
  const walk = (dir: string, prefix: string[], depth: number) => {
    if (seen.has(dir)) return
    seen.add(dir)
    for (const entry of entries(root, dir, diagnostics)) {
      if (entry.directory) {
        if (depth < 4) walk(entry.real, [...prefix, entry.name], depth + 1)
      } else if (entry.name.endsWith(".md")) found.push({ file: entry.real, name: [...prefix, entry.name.slice(0, -3)].join(":") })
    }
  }
  walk(path, [], 0)
  return found
}

/** A plugin file read only when it is inside the root after resolving links; undefined when missing. */
function pluginFile(root: string, path: string): { path: string; text: string } | undefined {
  const real = containedPath(root, path)
  return real === undefined ? undefined : { path: real, text: readFileSync(real, "utf8") }
}

/** Everything one plugin contributes. Per-file failures become diagnostics. */
export function loadPlugin(plugin: ClaudePlugin, settings: Settings): Omit<Bundle, "project" | "plugins"> {
  const { name, manifest } = plugin
  const root = realpathSync(plugin.root)
  const out: Omit<Bundle, "project" | "plugins"> = { skills: [], agents: [], commands: [], mcp: [], hooks: [], instructions: [], diagnostics: [] }
  const report = (where: string, error: unknown) => out.diagnostics.push({ where, message: String(error) })
  for (const key of ["lspServers", "outputStyles"])
    if (manifest[key] !== undefined) out.diagnostics.push({ where: name, message: `Manifest ${key} is not supported` })

  for (const dir of componentPaths({ ...plugin, root }, "skills", "skills", out.diagnostics))
    for (const path of skillFiles(root, dir, out.diagnostics)) {
      try {
        const converted = convertSkill(path, root)
        out.skills.push(converted.skill)
        out.diagnostics.push(...converted.diagnostics)
      } catch (error) {
        report(path, error)
      }
    }

  for (const dir of componentPaths({ ...plugin, root }, "agents", "agents", out.diagnostics))
    for (const { file, name: agentName } of markdownFiles(root, dir, out.diagnostics)) {
      try {
        const converted = convertAgent(readFileSync(file, "utf8"), { plugin: name, name: agentName, root }, settings)
        out.agents.push(converted.agent)
        out.diagnostics.push(...converted.diagnostics)
      } catch (error) {
        report(file, error)
      }
    }

  for (const dir of componentPaths({ ...plugin, root }, "commands", "commands", out.diagnostics))
    for (const { file, name: commandName } of markdownFiles(root, dir, out.diagnostics)) {
      try {
        const converted = convertCommand(readFileSync(file, "utf8"), `${name}:${commandName}`, root)
        out.commands.push({ ...converted.command, plugin: name })
        out.diagnostics.push(...converted.diagnostics)
      } catch (error) {
        report(file, error)
      }
    }

  const servers: McpServers = {}
  const mcpDocuments: [unknown, string][] = []
  try {
    const file = pluginFile(root, ".mcp.json")
    if (file) mcpDocuments.push([JSON.parse(file.text), file.path])
    if (typeof manifest.mcpServers === "string") {
      const path = inside(root, manifest.mcpServers)
      mcpDocuments.push([JSON.parse(readFileSync(path, "utf8")), path])
    } else if (isRecord(manifest.mcpServers)) mcpDocuments.push([{ mcpServers: manifest.mcpServers }, `${name}: manifest mcpServers`])
  } catch (error) {
    report(`${name}: mcp`, error)
  }
  for (const [document, where] of mcpDocuments) {
    try {
      Object.assign(servers, parseClaudeMcp(document, where))
    } catch (error) {
      report(where, error)
    }
  }
  if (Object.keys(servers).length > 0) out.mcp.push({ plugin: name, root, servers })

  const hookDocuments: [unknown, string][] = []
  try {
    const file = pluginFile(root, join("hooks", "hooks.json"))
    const path = file?.path
    if (file) hookDocuments.push([JSON.parse(file.text), file.path])
    for (const item of Array.isArray(manifest.hooks) ? manifest.hooks : manifest.hooks === undefined ? [] : [manifest.hooks]) {
      if (typeof item === "string") {
        const file = inside(root, item)
        if (file !== path) hookDocuments.push([JSON.parse(readFileSync(file, "utf8")), file])
      } else hookDocuments.push([isRecord(item) && "hooks" in item ? item : { hooks: item }, `${name}: manifest hooks`])
    }
  } catch (error) {
    report(`${name}: hooks`, error)
  }
  for (const [document, where] of hookDocuments) {
    const parsed = parseHooks(document, name, root, where)
    out.diagnostics.push(...parsed.diagnostics)
    if (settings.hooks) out.hooks.push(...parsed.hooks)
    else if (parsed.hooks.length > 0) out.diagnostics.push({ where, message: `${parsed.hooks.length} hook(s) not run: hooks is off` })
  }

  try {
    const claudeMd = pluginFile(root, "CLAUDE.md")
    if (claudeMd && settings.instructions) out.instructions.push({ plugin: name, text: rewriteRoot(claudeMd.text.trim(), root) })
    else if (claudeMd) out.diagnostics.push({ where: claudeMd.path, message: "Plugin CLAUDE.md not included (instructions: false)" })
  } catch (error) {
    report(`${name}: CLAUDE.md`, error)
  }
  return out
}

type SourceResolver = typeof sourcePath

/** Read every group's sources for `project`. A plugin root or id seen before is skipped, reported. */
export async function loadBundle(project: string, groups: readonly Group[], settings: Settings, resolve: SourceResolver = sourcePath): Promise<Bundle> {
  const bundle: Bundle = { project, plugins: [], skills: [], agents: [], commands: [], mcp: [], hooks: [], instructions: [], diagnostics: [] }
  const roots = new Set<string>()
  const ids = { skills: new Set<string>(), agents: new Set<string>(), commands: new Set<string>(), mcp: new Set<string>() }
  for (const group of groups) {
    const found = new Set<string>()
    for (const source of group.sources) {
      let plugins: ClaudePlugin[]
      try {
        plugins = discoverPlugins(await resolve(source, project), (where, message) => bundle.diagnostics.push({ where, message }))
      } catch (error) {
        bundle.diagnostics.push({ where: `${group.origin}: ${JSON.stringify(source)}`, message: String(error) })
        continue
      }
      for (const plugin of plugins) {
        if (group.plugins && !group.plugins.includes(plugin.name)) continue
        found.add(plugin.name)
        const real = realpathSync(plugin.root)
        if (roots.has(real)) {
          bundle.diagnostics.push({ where: plugin.name, message: `Already loaded from ${real}; skipped` })
          continue
        }
        roots.add(real)
        bundle.plugins.push({ name: plugin.name, root: plugin.root })
        const part = loadPlugin(plugin, settings)
        bundle.diagnostics.push(...part.diagnostics)
        bundle.skills.push(...dedupe(part.skills, ids.skills, (skill) => skill.id, "skill", plugin.name, bundle.diagnostics))
        bundle.agents.push(...dedupe(part.agents, ids.agents, (agent) => agent.id, "agent", plugin.name, bundle.diagnostics))
        bundle.commands.push(...dedupe(part.commands, ids.commands, (command) => command.name, "command", plugin.name, bundle.diagnostics))
        for (const entry of part.mcp) {
          const servers: McpServers = {}
          for (const [server, config] of Object.entries(entry.servers)) {
            if (ids.mcp.has(server)) bundle.diagnostics.push({ where: plugin.name, message: `Duplicate MCP server ${server}; first one kept` })
            else {
              ids.mcp.add(server)
              servers[server] = config
            }
          }
          if (Object.keys(servers).length > 0) bundle.mcp.push({ ...entry, servers })
        }
        bundle.hooks.push(...part.hooks)
        bundle.instructions.push(...part.instructions)
      }
    }
    for (const name of group.plugins ?? [])
      if (!found.has(name)) bundle.diagnostics.push({ where: `${group.origin}: ${name}`, message: "Selected plugin not found" })
  }
  return bundle
}

function dedupe<T>(items: T[], seen: Set<string>, id: (item: T) => string, kind: string, plugin: string, diagnostics: Diagnostic[]): T[] {
  return items.filter((item) => {
    const key = id(item)
    if (seen.has(key)) {
      diagnostics.push({ where: plugin, message: `Duplicate ${kind} ${key}; first one kept` })
      return false
    }
    seen.add(key)
    return true
  })
}

type Entry = { bundle: Promise<Bundle>; users: number }
const bundles = new Map<string, Entry>()

/** The cache key: the project root first, so two projects never share an entry. */
export function bundleKey(project: string, groups: readonly Group[], settings: Settings): string {
  return JSON.stringify([project, groups, settings])
}

/**
 * The bundle for `key`, loading it on first use. Setups of the same project and
 * configuration (several locations in one project) share it; the last release drops it,
 * so a reload reads the sources again.
 */
export async function acquireBundle(key: string, load: () => Promise<Bundle>): Promise<{ bundle: Bundle; release: () => void }> {
  let entry = bundles.get(key)
  if (!entry) {
    entry = { bundle: load(), users: 0 }
    bundles.set(key, entry)
  }
  entry.users++
  const current = entry
  let released = false
  const release = () => {
    if (released) return
    released = true
    current.users--
    if (current.users === 0 && bundles.get(key) === current) bundles.delete(key)
  }
  try {
    return { bundle: await current.bundle, release }
  } catch (error) {
    release()
    throw error
  }
}

/** Project roots with a live cached bundle, for tests and the check tool. */
export function cachedProjects(): string[] {
  return [...bundles.keys()].map((key) => (JSON.parse(key) as [string])[0])
}
