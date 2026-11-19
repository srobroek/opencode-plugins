/** The docs check: OpenCode API and schema references that drifted from the installed versions. */

import { compareVersions } from "../../dep-update/src/bump.ts"
import { type Finding, objectAt, plainVersion, type RepoSnapshot, ROOT } from "./model.ts"

const BIOME_SCHEMA = /biomejs\.dev\/schemas\/(\d+\.\d+\.\d+)\//g
const V1_IMPORT = /["']@opencode-ai\/plugin(?:\/[\w./-]*)?["']/

/**
 * Drift in the docs and API references. `opencodeLatest` is the npm latest of
 * `@opencode/plugin`, or undefined when the registry was not consulted.
 */
export function checkDocs(repo: RepoSnapshot, opencodeLatest?: string): Finding[] {
  const findings: Finding[] = []
  const devDependencies = objectAt(repo.root, "devDependencies")

  const pinned = plainVersion(devDependencies["@opencode/plugin"])
  if (pinned !== undefined && opencodeLatest !== undefined && (compareVersions(opencodeLatest, pinned) ?? 0) > 0) {
    findings.push({
      category: "docs",
      plugin: ROOT,
      severity: "info",
      code: "opencode-api-release",
      file: "package.json",
      message: `@opencode/plugin pinned ${pinned}, npm latest ${opencodeLatest}: read its release notes (context7 /sst/opencode or the whats-new agent) before bumping`,
    })
  }

  // A $schema URL names the version of the tool it validates against; it should match what is installed.
  const biomeInstalled = plainVersion(devDependencies["@biomejs/biome"])
  if (biomeInstalled !== undefined) {
    const schemaFiles = [
      ...(repo.biome === undefined ? [] : [{ path: "biome.json", text: repo.biome }]),
      ...repo.plugins.flatMap((plugin) => plugin.skills),
    ]
    for (const file of schemaFiles) {
      for (const match of file.text.matchAll(BIOME_SCHEMA)) {
        if (match[1] === biomeInstalled) continue
        findings.push({
          category: "docs",
          plugin: file.path.startsWith("plugins/") ? (file.path.split("/")[1] ?? ROOT) : ROOT,
          severity: "warn",
          code: "schema-version",
          file: file.path,
          message: `$schema pins Biome ${match[1]}; installed @biomejs/biome is ${biomeInstalled}`,
        })
      }
    }
  }

  for (const plugin of repo.plugins) {
    const file = plugin.src.find((source) => V1_IMPORT.test(source.text))
    if (file === undefined) continue
    findings.push({
      category: "docs",
      plugin: plugin.name,
      severity: "error",
      code: "v1-api",
      file: file.path,
      message: "imports the V1 API @opencode-ai/plugin; OpenCode V2 plugins use @opencode/plugin",
    })
  }
  return findings
}
