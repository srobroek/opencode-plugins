/** Reads the repository into a RepoSnapshot. The only module that touches the file system. */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Json, PluginSnapshot, RepoSnapshot, SourceFile } from "./model.ts"

function readText(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined
}

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json
}

/** Files under `dir` (relative paths) whose names pass `keep`, read as text. */
function filesUnder(dir: string, keep: (relative: string) => boolean): SourceFile[] {
  if (!existsSync(dir)) return []
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((relative) => keep(relative))
    .sort()
    .map((relative) => ({ path: relative.split("\\").join("/"), text: readFileSync(join(dir, relative), "utf8") }))
}

function loadPlugin(root: string, name: string): PluginSnapshot {
  const dir = join(root, "plugins", name)
  const isTest = (relative: string) => /\.test\.tsx?$/.test(relative)
  const src = filesUnder(join(dir, "src"), (relative) => /\.tsx?$/.test(relative))
  const tests = src
    .map((file) => file.path.slice(file.path.lastIndexOf("/") + 1))
    .filter((name) => /\.test\.ts$/.test(name))
    .sort()
  return {
    name,
    manifest: readJson(join(dir, "package.json")),
    src: src
      .filter((file) => !isTest(file.path))
      .map((file) => ({ path: `plugins/${name}/src/${file.path}`, text: file.text })),
    skills: filesUnder(join(dir, "skills"), (relative) => relative.endsWith(".md")).map((file) => ({
      path: `plugins/${name}/skills/${file.path}`,
      text: file.text,
    })),
    agents: existsSync(join(dir, "agents"))
      ? readdirSync(join(dir, "agents"))
          .filter((entry) => entry.endsWith(".md"))
          .sort()
          .map((entry) => ({ path: `plugins/${name}/agents/${entry}`, text: readFileSync(join(dir, "agents", entry), "utf8") }))
      : [],
    hasSkillsDir: existsSync(join(dir, "skills")),
    hasAgentsDir: existsSync(join(dir, "agents")),
    hasReadme: existsSync(join(dir, "README.md")),
    hasChangelog: existsSync(join(dir, "CHANGELOG.md")),
    tests,
  }
}

/** Loads the root package.json and every plugins/<name>/ directory that has a package.json. */
export function loadRepo(root: string): RepoSnapshot {
  const pluginsDir = join(root, "plugins")
  const names = existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, "package.json")))
        .map((entry) => entry.name)
        .sort()
    : []
  const biome = readText(join(root, "biome.json"))
  const releaseConfig = readText(join(root, "release-please-config.json"))
  const releaseManifest = readText(join(root, ".release-please-manifest.json"))
  return {
    root: readJson(join(root, "package.json")),
    biome,
    plugins: names.map((name) => loadPlugin(root, name)),
    releaseConfig: releaseConfig === undefined ? undefined : (JSON.parse(releaseConfig) as Json),
    releaseManifest: releaseManifest === undefined ? undefined : (JSON.parse(releaseManifest) as Record<string, string>),
  }
}
