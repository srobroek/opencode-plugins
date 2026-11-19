/** Shared types and small helpers for plugin-audit: findings, the repository snapshot and version specs. */

export const CATEGORIES = ["versions", "docs", "practices", "bumps", "consistency"] as const
export type Category = (typeof CATEGORIES)[number]

export type Severity = "error" | "warn" | "info"
export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

export type Finding = {
  category: Category
  plugin: string
  severity: Severity
  code: string
  message: string
  file?: string
}

/** Plugin label for a finding about the root package.json. */
export const ROOT = "(root)"
/** Plugin label for a finding about the whole repository. */
export const REPO = "(repo)"

export type Json = Record<string, unknown>
export type SourceFile = { path: string; text: string }

export type PluginSnapshot = {
  /** The directory name under plugins/. */
  name: string
  manifest: Json
  /** Non-test TypeScript under src/. */
  src: SourceFile[]
  /** Markdown under skills/, recursively. */
  skills: SourceFile[]
  /** Composed shipped agents under agents/ (never agents.src/). */
  agents: SourceFile[]
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasReadme: boolean
  hasChangelog: boolean
  /** Names of src/*.test.ts files. */
  tests: string[]
}

export type RepoSnapshot = {
  root: Json
  /** Text of biome.json, when present. */
  biome?: string
  plugins: PluginSnapshot[]
  /** release-please-config.json, when present. */
  releaseConfig?: Json
  /** .release-please-manifest.json, when present: `plugins/<name>` to version. */
  releaseManifest?: Record<string, string>
}

export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"] as const

/** The object under `key`, or an empty object when the manifest lacks it or it is not an object. */
export function objectAt(source: Json, key: string): Record<string, unknown> {
  const value = source[key]
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * The exact version a spec names: `1.2.3`, `^1.2.3`, `~1.2.3` or `=1.2.3`. Undefined for
 * anything else (workspace:*, file:, git URLs, dist-tags, compound ranges).
 */
export function plainVersion(spec: unknown): string | undefined {
  if (typeof spec !== "string") return undefined
  return /^[\^~=]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec.trim())?.[1]
}

/**
 * The host modules OpenCode supplies at runtime. Copied from HOST_MODULES in scripts/build.ts,
 * which cannot be imported (it runs its build when loaded). Only the four that AGENTS.md pins
 * to the latest release are listed; `effect` is left out on purpose.
 */
export const HOST_MODULES = ["@opencode/plugin", "@opencode/client", "@opentui/*", "solid-js"] as const

export function isHostModule(name: string): boolean {
  return HOST_MODULES.some((pattern) =>
    pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  )
}
