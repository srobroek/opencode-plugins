/** The bumps check: release-please bookkeeping and commits that wait for the next release. */

import type { Finding, RepoSnapshot } from "./model.ts"

/** The lib package has no release of its own; release-please does not track it. */
const UNTRACKED = new Set(["lib"])

/** The release-please tag for a plugin version, e.g. `worktrunk--v0.4.1`. */
export function releaseTag(name: string, version: string): string {
  return `${name}--v${version}`
}

/**
 * Release bookkeeping per plugin. `unreleased` maps a plugin to the commits since its release
 * tag (null when the tag is missing); a plugin absent from the map was not counted.
 */
export function checkBumps(repo: RepoSnapshot, unreleased: ReadonlyMap<string, number | null>): Finding[] {
  const findings: Finding[] = []
  for (const plugin of repo.plugins) {
    if (UNTRACKED.has(plugin.name)) continue
    const key = `plugins/${plugin.name}`
    const base = { category: "bumps", plugin: plugin.name } as const
    const manifestVersion = repo.releaseManifest?.[key]
    const packageVersion = plugin.manifest.version
    if (manifestVersion === undefined) {
      findings.push({ ...base, severity: "error", code: "release-manifest", message: `no ${key} entry in .release-please-manifest.json`, file: ".release-please-manifest.json" })
      continue
    }
    if (packageVersion !== manifestVersion) {
      findings.push({
        ...base,
        severity: "error",
        code: "version-mismatch",
        message: `package.json is ${String(packageVersion)}, release manifest is ${manifestVersion}`,
        file: `plugins/${plugin.name}/package.json`,
      })
    }
    const packages = (repo.releaseConfig?.packages ?? {}) as Record<string, unknown>
    if (!(key in packages)) {
      findings.push({ ...base, severity: "error", code: "release-config", message: `no ${key} package in release-please-config.json`, file: "release-please-config.json" })
    }
    const count = unreleased.get(plugin.name)
    if (count === undefined) continue
    const tag = releaseTag(plugin.name, manifestVersion)
    if (count === null) {
      findings.push({ ...base, severity: "info", code: "tag-missing", message: `no tag ${tag}; cannot count unreleased commits` })
    } else if (count > 0) {
      findings.push({ ...base, severity: "info", code: "unreleased", message: `${count} unreleased commits since ${tag}` })
    }
  }
  return findings
}
