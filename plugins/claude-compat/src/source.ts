import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { Diagnostic } from "./convert.ts"

export type Source = { path: string } | { git: string; ref: string }
const exec = promisify(execFile)

/** Where a project's own source list lives, relative to the project root. */
export const PROJECT_FILE = join(".opencode", "claude-compat.json")

export function parseSources(value: unknown): Source[] {
  if (!Array.isArray(value)) throw new Error("claude-compat: sources must be an array")
  return value.map((item) => {
    if (item && typeof item.path === "string" && item.git === undefined) return { path: item.path }
    if (item && typeof item.git === "string" && typeof item.ref === "string" && item.path === undefined)
      return { git: item.git, ref: item.ref }
    throw new Error("claude-compat: source needs path, or git and ref")
  })
}

function parsePlugins(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string"))
    throw new Error("claude-compat: plugins must be a list of names")
  return value
}

/** The real path when it exists, else the path as given. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function expandHome(path: string, home = homedir()): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path
}

/** Whether `path` is `root` or inside it, lexically. */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
}

/**
 * A set of sources and an optional plugin-name filter, from one place in the configuration.
 * A group from a project file carries the file's canonical path and text: it is untrusted
 * until approved (see `trust.ts`).
 */
export type Group = { origin: string; sources: Source[]; plugins?: string[]; projectFile?: { path: string; text: string; digest?: string } }

function group(origin: string, value: Record<string, unknown>): Group | undefined {
  if (value.sources === undefined) return undefined
  const plugins = parsePlugins(value.plugins)
  return { origin, sources: parseSources(value.sources), ...(plugins ? { plugins } : {}) }
}

/**
 * The source groups that apply to `project`: the plugin options' own `sources`, every
 * `projects` entry whose directory is the project or contains it, and, only with
 * `projectFile: true`, the project's `.opencode/claude-compat.json`. Relative source paths
 * resolve against the project root later, in {@link sourcePath}.
 */
export function configGroups(
  options: Record<string, unknown>,
  project: string,
  read: (path: string) => string | undefined = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
): { groups: Group[]; diagnostics: Diagnostic[] } {
  const groups: Group[] = []
  const diagnostics: Diagnostic[] = []
  const own = group("options", options)
  if (own) groups.push(own)
  else if (options.plugins !== undefined) parsePlugins(options.plugins)
  const projects = options.projects
  if (projects !== undefined) {
    if (!projects || typeof projects !== "object" || Array.isArray(projects))
      throw new Error("claude-compat: projects must map directories to { sources, plugins }")
    for (const [directory, value] of Object.entries(projects)) {
      if (!within(resolve(expandHome(directory)), project)) continue
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`claude-compat: projects.${directory} must be an object`)
      const entry = group(`projects.${directory}`, value as Record<string, unknown>)
      if (entry) groups.push(entry)
    }
  }
  if (options.projectFile === true) {
    const path = join(project, PROJECT_FILE)
    try {
      const text = read(path)
      if (text !== undefined) {
        const value: unknown = JSON.parse(text)
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object")
        const entry = group(PROJECT_FILE, value as Record<string, unknown>)
        if (entry) groups.push({ ...entry, projectFile: { path: canonical(path), text } })
      }
    } catch (error) {
      diagnostics.push({ where: path, message: String(error) })
    }
  }
  return { groups, diagnostics }
}

/** The content-addressed checkout location for a git URL/ref, without fetching anything. */
export function gitCachePath(source: { git: string; ref: string }): string {
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "claude-compat")
  const key = createHash("sha256").update(JSON.stringify(source)).digest("hex")
  return join(cache, key)
}

/** Checkout only in our cache; never change a caller-owned clone. Ref is resolved once per cache key. */
export async function sourcePath(source: Source, directory: string): Promise<string> {
  if ("path" in source) return realpathSync(resolve(directory, expandHome(source.path)))
  if (!source.git || source.git.startsWith("-") || !source.ref || source.ref.startsWith("-")) throw new Error("invalid git source/ref")
  const target = gitCachePath(source)
  const cache = join(target, "..")
  if (existsSync(target)) return realpathSync(target)
  mkdirSync(cache, { recursive: true })
  const scratch = `${target}.tmp-${crypto.randomUUID()}`
  try {
    await exec("git", ["clone", "--no-checkout", "--", source.git, scratch], {
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    // --end-of-options prevents ref strings from becoming revision flags.
    const { stdout } = await exec("git", ["-C", scratch, "rev-parse", "--verify", "--end-of-options", `${source.ref}^{commit}`])
    await exec("git", ["-C", scratch, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", stdout.trim()], { timeout: 120_000 })
    if (!existsSync(target)) renameSync(scratch, target)
    return realpathSync(target)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export type ClaudePlugin = { name: string; root: string; manifest: Record<string, unknown> }
const document = (path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected object`)
  return value as Record<string, unknown>
}

export function inside(root: string, path: string): string {
  const base = realpathSync(root)
  const full = realpathSync(resolve(base, path))
  if (!within(base, full)) throw new Error(`path escapes source: ${path}`)
  return full
}

/** {@link inside} for a path that may be missing: undefined when it does not exist (or is a broken link). */
export function containedPath(root: string, path: string): string | undefined {
  return existsSync(resolve(root, path)) ? inside(root, path) : undefined
}

/**
 * The plugins of a marketplace (`.claude-plugin/marketplace.json`) or of a single plugin
 * directory (`.claude-plugin/plugin.json`). Marketplace entries must be local paths inside
 * the marketplace; an entry without its own `plugin.json` uses the entry as its manifest.
 */
export function discoverPlugins(root: string, report?: (where: string, message: string) => void): ClaudePlugin[] {
  const marketplace = join(root, ".claude-plugin", "marketplace.json")
  if (!existsSync(marketplace)) {
    const manifest = document(inside(root, join(".claude-plugin", "plugin.json")))
    if (typeof manifest.name !== "string") throw new Error("plugin manifest needs name")
    return [{ name: manifest.name, root, manifest }]
  }
  const entries = document(inside(root, marketplace)).plugins
  if (!Array.isArray(entries)) throw new Error("marketplace plugins must be a list")
  const plugins: ClaudePlugin[] = []
  for (const entry of entries) {
    try {
      if (!entry || typeof entry.name !== "string" || typeof entry.source !== "string" || /^[a-z]+:/i.test(entry.source))
        throw new Error("only named local marketplace sources are supported")
      const dir = inside(root, entry.source)
      const path = join(dir, ".claude-plugin", "plugin.json")
      const manifest = existsSync(path) ? document(inside(dir, path)) : { ...entry }
      plugins.push({ name: entry.name, root: dir, manifest })
    } catch (error) {
      if (!report) throw error
      report(typeof entry?.name === "string" ? entry.name : marketplace, String(error))
    }
  }
  return plugins
}
