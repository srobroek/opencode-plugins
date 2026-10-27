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

/** The model-roles entry of a config's `plugins` array, if any. */
export function findPluginEntry(text: string): PluginEntry | undefined {
  const root = parse(text)
  const plugins = root === undefined ? undefined : findNodeAtLocation(root, ["plugins"])
  if (plugins?.type !== "array") return undefined
  for (const [index, child] of (plugins.children ?? []).entries()) {
    const value = getNodeValue(child) as unknown
    if (typeof value === "string" && PLUGIN_SPEC.test(value)) return { index, spec: value, bare: true }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const spec = (value as { package?: unknown }).package
      if (typeof spec === "string" && PLUGIN_SPEC.test(spec)) return { index, spec, bare: false }
    }
  }
  return undefined
}

/** The `options.tiers` object of the model-roles entry, or `{}`. */
export function readTiers(text: string): Record<string, unknown> {
  const entry = findPluginEntry(text)
  const root = parse(text)
  if (entry === undefined || entry.bare || root === undefined) return {}
  const node = findNodeAtLocation(root, ["plugins", entry.index, "options", "tiers"])
  const value = node === undefined ? undefined : (getNodeValue(node) as unknown)
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * Set `options.tiers.<name>` of the model-roles entry to `value`, or remove it when
 * `value` is undefined. A bare string entry becomes `{ "package": …, "options": … }`.
 * Returns `undefined` when the text has no model-roles entry.
 */
export function setTier(text: string, name: string, value: unknown): string | undefined {
  const entry = findPluginEntry(text)
  if (entry === undefined) return undefined
  if (entry.bare) {
    if (value === undefined) return text
    const replacement = { package: entry.spec, options: { tiers: { [name]: value } } }
    return applyEdits(text, modify(text, ["plugins", entry.index], replacement, { formattingOptions: FORMATTING }))
  }
  return applyEdits(
    text,
    modify(text, ["plugins", entry.index, "options", "tiers", name], value, { formattingOptions: FORMATTING }),
  )
}

export type ConfigFile = { path: string; text: string }

/**
 * The global config file to edit: the highest-precedence one (`opencode.jsonc` over
 * `opencode.json`) that has a model-roles entry. `undefined` when none has one.
 */
export function pickConfigFile(files: ReadonlyArray<ConfigFile>): ConfigFile | undefined {
  const order = (file: ConfigFile) => CONFIG_NAMES.indexOf(path.basename(file.path) as (typeof CONFIG_NAMES)[number])
  return [...files].sort((a, b) => order(b) - order(a)).find((file) => findPluginEntry(file.text) !== undefined)
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

/** Set one tier in the global config file that holds the model-roles entry, and write it. */
export function writeTier(dir: string, name: string, value: unknown): WriteResult {
  const file = pickConfigFile(readConfigFiles(dir))
  if (file === undefined)
    throw new Error(`No model-roles plugin entry in ${CONFIG_NAMES.map((n) => path.join(dir, n)).join(" or ")}; add the plugin to the global config first.`)
  const next = setTier(file.text, name, value)
  if (next === undefined) throw new Error(`No model-roles plugin entry in ${file.path}.`)
  if (next !== file.text) writeFileSync(file.path, next.endsWith("\n") ? next : `${next}\n`)
  return { path: file.path, tiers: readTiers(next) }
}
