/** The consistency check: what must agree across plugins, and what each plugin must ship next to its code. */

import { type Finding, objectAt, REPO, type RepoSnapshot, ROOT } from "./model.ts"

const SCOPES = ["global", "project", "internal"]

/** Groups the values of one key by their spec, keeping which plugins declared each. */
function variants(entries: Array<{ plugin: string; spec: string }>): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const entry of entries) grouped.set(entry.spec, [...(grouped.get(entry.spec) ?? []), entry.plugin])
  return grouped
}

function describe(grouped: Map<string, string[]>): string {
  return [...grouped].map(([spec, plugins]) => `${spec} (${plugins.join(", ")})`).join("; ")
}

export function checkConsistency(repo: RepoSnapshot): Finding[] {
  const findings: Finding[] = []
  const base = { category: "consistency" as const }

  for (const plugin of repo.plugins) {
    const scope = objectAt(plugin.manifest, "opencode-plugins").scope
    if (typeof scope !== "string" || !SCOPES.includes(scope)) {
      findings.push({
        ...base,
        plugin: plugin.name,
        severity: "error",
        code: "scope-missing",
        message: `"opencode-plugins".scope must be one of ${SCOPES.join(", ")}`,
        file: `plugins/${plugin.name}/package.json`,
      })
    }
    const missing: Array<[string, boolean, string]> = [
      ["readme-missing", plugin.hasReadme, "README.md"],
      ["tests-missing", plugin.tests.length > 0, "src/*.test.ts"],
    ]
    // Internal packages are never released, so release-please writes no changelog for them.
    if (scope !== "internal") missing.splice(1, 0, ["changelog-missing", plugin.hasChangelog, "CHANGELOG.md"])
    for (const [code, present, what] of missing) {
      if (!present) findings.push({ ...base, plugin: plugin.name, severity: "warn", code, message: `no ${what}` })
    }
  }

  const peers = variants(
    repo.plugins.map((plugin) => ({
      plugin: plugin.name,
      spec: String(objectAt(plugin.manifest, "peerDependencies")["@opencode/plugin"] ?? "(none)"),
    })),
  )
  if (peers.size > 1) {
    findings.push({
      ...base,
      plugin: REPO,
      severity: "warn",
      code: "peer-range",
      message: `@opencode/plugin peer range differs across plugins: ${describe(peers)}`,
    })
  }

  const devSpecs = new Map<string, Array<{ plugin: string; spec: string }>>()
  const declarations = [
    { plugin: ROOT, manifest: repo.root },
    ...repo.plugins.map((plugin) => ({ plugin: plugin.name, manifest: plugin.manifest })),
  ]
  for (const { plugin, manifest } of declarations) {
    for (const [name, spec] of Object.entries(objectAt(manifest, "devDependencies"))) {
      if (typeof spec !== "string" || spec.startsWith("workspace:")) continue
      devSpecs.set(name, [...(devSpecs.get(name) ?? []), { plugin, spec }])
    }
  }
  for (const [name, entries] of devSpecs) {
    const grouped = variants(entries)
    if (grouped.size > 1) {
      findings.push({
        ...base,
        plugin: REPO,
        severity: "warn",
        code: "dev-dependency",
        message: `devDependency ${name} is pinned differently: ${describe(grouped)}`,
      })
    }
  }
  return findings
}
