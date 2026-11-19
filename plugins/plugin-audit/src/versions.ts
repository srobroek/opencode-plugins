/** The versions check: every declared dependency against the npm latest stable release. */

import type { BumpRecord } from "../../dep-update/src/bump.ts"
import {
  DEPENDENCY_SECTIONS,
  type Finding,
  isHostModule,
  objectAt,
  plainVersion,
  type RepoSnapshot,
  ROOT,
} from "./model.ts"

/** Classifies `installed` against the npm latest stable (dep-update's queryRegistry). */
export type Lookup = (name: string, installed: string) => Promise<BumpRecord>

type Source = { plugin: string; file: string; manifest: Record<string, unknown>; root: boolean }

/** A gap finding for one dependency, or none when it is current. */
function gap(source: Source, name: string, spec: string, record: BumpRecord): Finding | undefined {
  const base = { category: "versions", plugin: source.plugin, file: source.file } as const
  if (record.class === undefined || record.class === "UNRESOLVABLE" || record.class === "DISCONFIRMED") {
    return {
      ...base,
      severity: "info",
      code: "not-queried",
      message: `${name} ${spec}: could not check npm (${record.reason ?? record.status})`,
    }
  }
  if (record.class === "CURRENT") return undefined
  const latest = record.latest ?? "unknown"
  const message = `${name} ${spec} -> ${latest} (${record.class.toLowerCase()})`
  const host = source.root && isHostModule(name)
  if (host) {
    // AGENTS.md pins host modules to the latest release, so any gap is a warning; a major one needs a decision.
    return record.class === "MAJOR-ADVISORY"
      ? { ...base, severity: "info", code: "host-major", message: `${message}: decide manually` }
      : { ...base, severity: "warn", code: "host-behind", message }
  }
  if (record.class === "MAJOR-ADVISORY") return { ...base, severity: "warn", code: "outdated-major", message }
  return { ...base, severity: "info", code: record.class === "MINOR-CHECK" ? "outdated-minor" : "outdated-patch", message }
}

/**
 * Each plain-version dependency of the root and of every plugin, classified against npm.
 * `lookup` is called once per dependency, so a caller may memoise it.
 */
export async function checkVersions(repo: RepoSnapshot, lookup: Lookup): Promise<Finding[]> {
  const sources: Source[] = [
    { plugin: ROOT, file: "package.json", manifest: repo.root, root: true },
    ...repo.plugins.map((plugin) => ({
      plugin: plugin.name,
      file: `plugins/${plugin.name}/package.json`,
      manifest: plugin.manifest,
      root: false,
    })),
  ]
  const findings: Finding[] = []
  for (const source of sources) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(objectAt(source.manifest, section))) {
        const installed = plainVersion(spec)
        if (installed === undefined) continue
        const finding = gap(source, name, String(spec), await lookup(name, installed))
        if (finding !== undefined) findings.push(finding)
      }
    }
  }
  return findings
}
