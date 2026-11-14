/**
 * Write `options.tiers` into the model-roles entry of the global OpenCode config.
 * `/api/experimental/config` only patches `shell`, so the plugin edits the file
 * itself, with jsonc-parser so comments and formatting survive. Pure apart from
 * `writeTier`, which reads and writes the chosen file.
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { applyEdits, findNodeAtLocation, getNodeValue, modify, type Node, parseTree } from "jsonc-parser"

/** Config file names, lowest precedence first (OpenCode 2.1.4 `config/discovery.ts`). */
export const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"] as const

/** A plugin spec that names this plugin: a package, git or path spec ending in model-roles. */
export const PLUGIN_SPEC = /(^|[/:@])(opencode-)?model-roles\b/

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: "\n" } as const

/** The global config directory: `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export function globalConfigDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

export type PluginEntry = {
  /** Index in the `plugins` array. */
  index: number
  /** The spec string, bare or under `package`. */
  spec: string
  bare: boolean
}

const parse = (text: string): Node | undefined => parseTree(text, [], { allowTrailingComma: true, disallowComments: false })

/**
 * The model-roles entry of a config's `plugins` array, if any. With `spec`, only an entry whose package
 * string is exactly `spec`: OpenCode keys plugin entries by that string, so another string is a separate instance.
 */
export function findPluginEntry(text: string, spec?: string): PluginEntry | undefined {
  const named = (value: string) => (spec === undefined ? PLUGIN_SPEC.test(value) : value === spec)
  const root = parse(text)
  const plugins = root === undefined ? undefined : findNodeAtLocation(root, ["plugins"])
  if (plugins?.type !== "array") return undefined
  for (const [index, child] of (plugins.children ?? []).entries()) {
    const value = getNodeValue(child) as unknown
    if (typeof value === "string" && named(value)) return { index, spec: value, bare: true }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const pkg = (value as { package?: unknown }).package
      if (typeof pkg === "string" && named(pkg)) return { index, spec: pkg, bare: false }
    }
  }
  return undefined
}

/** An `options` object of the model-roles entry that maps names to values. */
export type Section = "tiers" | "agents"

const readSection = (text: string, section: Section, spec?: string): Record<string, unknown> => {
  const entry = findPluginEntry(text, spec)
  const root = parse(text)
  if (entry === undefined || entry.bare || root === undefined) return {}
  const node = findNodeAtLocation(root, ["plugins", entry.index, "options", section])
  const value = node === undefined ? undefined : (getNodeValue(node) as unknown)
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The `options.tiers` object of the model-roles entry, or `{}`. */
export const readTiers = (text: string, spec?: string): Record<string, unknown> => readSection(text, "tiers", spec)

/** The `options.agents` object (agent id to tier) of the model-roles entry, or `{}`. */
export const readAgents = (text: string, spec?: string): Record<string, unknown> => readSection(text, "agents", spec)

/**
 * Set `options.<section>.<name>` of the model-roles entry to `value`, or remove it when
 * `value` is undefined. A bare string entry becomes `{ "package": …, "options": … }`.
 * Returns `undefined` when the text has no model-roles entry.
 */
export function setEntry(text: string, section: Section, name: string, value: unknown, spec?: string): string | undefined {
  const entry = findPluginEntry(text, spec)
  if (entry === undefined) return undefined
  if (entry.bare) {
    if (value === undefined) return text
    const replacement = { package: entry.spec, options: { [section]: { [name]: value } } }
    return applyEdits(text, modify(text, ["plugins", entry.index], replacement, { formattingOptions: FORMATTING }))
  }
  return applyEdits(
    text,
    modify(text, ["plugins", entry.index, "options", section, name], value, { formattingOptions: FORMATTING }),
  )
}

/** Set or remove one `options.tiers` entry; see `setEntry`. */
export const setTier = (text: string, name: string, value: unknown, spec?: string): string | undefined => setEntry(text, "tiers", name, value, spec)

/** Set or remove one `options.agents` entry; see `setEntry`. */
export const setAgentTier = (text: string, agent: string, tier: string | undefined, spec?: string): string | undefined =>
  setEntry(text, "agents", agent, tier, spec)

export type ConfigFile = { path: string; text: string }

/**
 * The global config file to edit: the highest-precedence one (`opencode.jsonc` over
 * `opencode.json`) that has a model-roles entry. `undefined` when none has one.
 */
export function pickConfigFile(files: ReadonlyArray<ConfigFile>, spec?: string): ConfigFile | undefined {
  const order = (file: ConfigFile) => CONFIG_NAMES.indexOf(path.basename(file.path) as (typeof CONFIG_NAMES)[number])
  return [...files].sort((a, b) => order(b) - order(a)).find((file) => findPluginEntry(file.text, spec) !== undefined)
}

/** Read the global config files that exist. */
export function readConfigFiles(dir: string): ConfigFile[] {
  const files: ConfigFile[] = []
  for (const name of CONFIG_NAMES) {
    const file = path.join(dir, name)
    try {
      files.push({ path: file, text: readFileSync(file, "utf8") })
    } catch {
      // Not there.
    }
  }
  return files
}

export type WriteResult = { path: string; tiers: Record<string, unknown> }
export type AgentWriteResult = { path: string; agents: Record<string, unknown> }

/** Apply `edit` to the global config file that holds the model-roles entry, and write it. */
function writeEntry(dir: string, edit: (text: string) => string | undefined, spec?: string): { path: string; text: string } {
  const file = pickConfigFile(readConfigFiles(dir), spec)
  if (file === undefined)
    throw new Error(`No model-roles plugin entry in ${CONFIG_NAMES.map((n) => path.join(dir, n)).join(" or ")}; add the plugin to the global config first.`)
  const next = edit(file.text)
  if (next === undefined) throw new Error(`No model-roles plugin entry in ${file.path}.`)
  if (next !== file.text) writeFileSync(file.path, next.endsWith("\n") ? next : `${next}\n`)
  return { path: file.path, text: next }
}

/** Set one tier in the global config file that holds the model-roles entry, and write it. */
export function writeTier(dir: string, name: string, value: unknown, spec?: string): WriteResult {
  const { path: file, text } = writeEntry(dir, (current) => setTier(current, name, value, spec), spec)
  return { path: file, tiers: readTiers(text, spec) }
}

/** Set (or with `undefined` remove) one agent's tier override in that file, and write it. */
export function writeAgentTier(dir: string, agent: string, tier: string | undefined, spec?: string): AgentWriteResult {
  const { path: file, text } = writeEntry(dir, (current) => setAgentTier(current, agent, tier, spec), spec)
  return { path: file, agents: readAgents(text, spec) }
}

/**
 * Project config files that can hold a model-roles entry, lowest precedence first, as OpenCode
 * 2.2.6 loads them (`config/discovery.ts:81-82,143` and `config.ts:369-370`): every ancestor of
 * `directory`'s `opencode.json`, then `opencode.jsonc`, farthest first; then the same names inside each
 * ancestor's `.opencode/`, farthest first, so a `.opencode` file outranks every direct one. The global
 * config directory's own files are not project files.
 */
export function projectConfigPaths(directory: string, globalDir: string): string[] {
  const ancestors: string[] = []
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    ancestors.push(dir)
    if (path.dirname(dir) === dir) break
  }
  const far = ancestors.reverse()
  const direct = far.flatMap((dir) => CONFIG_NAMES.map((name) => path.join(dir, name)))
  const dotted = far.flatMap((dir) => CONFIG_NAMES.map((name) => path.join(dir, ".opencode", name)))
  const skip = new Set(CONFIG_NAMES.map((name) => path.join(path.resolve(globalDir), name)))
  return [...direct, ...dotted].filter((file) => !skip.has(file))
}

/** The project config files that exist, in `projectConfigPaths` order. */
export function readProjectFiles(directory: string, globalDir: string): ConfigFile[] {
  const files: ConfigFile[] = []
  for (const file of projectConfigPaths(directory, globalDir)) {
    try {
      files.push({ path: file, text: readFileSync(file, "utf8") })
    } catch {
      // Not there.
    }
  }
  return files
}

export type EffectiveConfig = (
  | { origin: "global"; path?: string }
  | { origin: "project"; path: string }
) & {
  /** `options.tiers` of the effective entry. */
  tiers: Record<string, unknown>
  /** `options.agents` of the effective entry. */
  agents: Record<string, unknown>
  /** A project config naming model-roles by another package string: OpenCode loads it as a second instance. */
  alsoLoads?: string
}

/**
 * Where the model-roles options (`tiers` and `agents`) come from. OpenCode keys plugin entries by the exact
 * package string and a project entry with the same string replaces the inherited one as a whole (options are
 * not merged). This instance's identity is `spec` (its own package target, when the host says), else the global
 * entry's string. The highest-precedence project file with an entry of that string is the effective one; the
 * global file does not count then. A project entry with another string is a second instance: it never shadows,
 * and its path is reported as `alsoLoads`. With no identity at all (no host answer, no global entry), any
 * model-roles-looking project entry counts. `project` is lowest precedence first.
 */
export function effectiveConfig(project: ReadonlyArray<ConfigFile>, global: ConfigFile | undefined, spec?: string): EffectiveConfig {
  const identity = spec ?? (global === undefined ? undefined : findPluginEntry(global.text, spec)?.spec)
  const newestFirst = [...project].reverse()
  const same = newestFirst.find((f) => findPluginEntry(f.text, identity) !== undefined)
  const other = identity === undefined ? undefined : newestFirst.find((f) => findPluginEntry(f.text) !== undefined && findPluginEntry(f.text, identity) === undefined)
  const extra = other === undefined ? {} : { alsoLoads: other.path }
  if (same !== undefined) return { origin: "project", path: same.path, tiers: readTiers(same.text, identity), agents: readAgents(same.text, identity), ...extra }
  if (global === undefined) return { origin: "global", tiers: {}, agents: {}, ...extra }
  return { origin: "global", path: global.path, tiers: readTiers(global.text, identity), agents: readAgents(global.text, identity), ...extra }
}
