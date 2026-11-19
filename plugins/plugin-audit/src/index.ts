import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { queryRegistry } from "../../dep-update/src/bump.ts"
import { checkBumps, releaseTag } from "./bumps.ts"
import { checkConsistency } from "./consistency.ts"
import { checkDocs } from "./docs.ts"
import { unreleasedCommits } from "./git.ts"
import { CATEGORIES, type Category, type Finding, objectAt, plainVersion, type RepoSnapshot } from "./model.ts"
import { checkPractices } from "./practices.ts"
import { loadRepo } from "./repo.ts"
import { formatReport } from "./report.ts"
import { checkVersions, type Lookup } from "./versions.ts"

export { checkBumps, releaseTag } from "./bumps.ts"
export { checkConsistency } from "./consistency.ts"
export { checkDocs } from "./docs.ts"
export { unreleasedCommits } from "./git.ts"
export { CATEGORIES, type Category, type Finding, isHostModule, plainVersion, type RepoSnapshot } from "./model.ts"
export { checkPractices } from "./practices.ts"
export { loadRepo } from "./repo.ts"
export { formatReport } from "./report.ts"
export { checkVersions, type Lookup } from "./versions.ts"

export const TOOL_NAME = "plugin_audit_scan"
export const SKILL_PATH = fileURLToPath(new URL("../skills/plugin-audit/SKILL.md", import.meta.url))

export type AuditOptions = {
  categories?: readonly Category[]
  /** Registry lookup for the versions and docs checks; undefined skips the network. */
  lookup?: Lookup
  git?: boolean
  signal?: AbortSignal
}

/** Runs the selected checks over a loaded repository. Pure except for the lookup and git calls. */
export async function runAudit(repo: RepoSnapshot, root: string, options: AuditOptions): Promise<Finding[]> {
  const selected = new Set<Category>(options.categories ?? CATEGORIES)
  const findings: Finding[] = []
  if (selected.has("versions") && options.lookup) findings.push(...(await checkVersions(repo, options.lookup)))
  if (selected.has("docs")) {
    const pinned = plainVersion(objectAt(repo.root, "devDependencies")["@opencode/plugin"])
    const latest =
      options.lookup && pinned ? (await options.lookup("@opencode/plugin", pinned)).latest : undefined
    findings.push(...checkDocs(repo, latest))
  }
  if (selected.has("practices")) for (const plugin of repo.plugins) findings.push(...checkPractices(plugin))
  if (selected.has("bumps")) {
    const unreleased = new Map<string, number | null>()
    if (options.git !== false) {
      for (const plugin of repo.plugins) {
        const version = repo.releaseManifest?.[`plugins/${plugin.name}`]
        if (version === undefined || plugin.name === "lib") continue
        unreleased.set(plugin.name, await unreleasedCommits(root, plugin.name, releaseTag(plugin.name, version), options.signal))
      }
    }
    findings.push(...checkBumps(repo, unreleased))
  }
  if (selected.has("consistency")) findings.push(...checkConsistency(repo))
  return findings
}

type ScanInput = { path?: string; plugins?: string[]; categories?: Category[]; offline?: boolean; git?: boolean }

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Repository root to audit; defaults to the session directory" },
    plugins: { type: "array", items: { type: "string" }, description: "Only these plugin directory names" },
    categories: {
      type: "array",
      items: { type: "string", enum: [...CATEGORIES] },
      description: "Subset of the five categories; defaults to all",
    },
    offline: { type: "boolean", description: "Skip npm lookups (versions and the @opencode/plugin release hint)" },
    git: { type: "boolean", description: "Count commits since each release tag; defaults to true" },
  },
  additionalProperties: false,
}

export default Plugin.define({
  id: "srobroek.plugin-audit",
  async setup(ctx) {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        description:
          "Read-only: audit a plugin monorepo for stale versions, docs drift, convention breaks, pending bumps and inconsistency.\n" +
          "Reads plugins/*/package.json, skills, agents, the release-please files and git tags. Npm lookups are " +
          "skipped with offline: true. Returns findings grouped by category, errors first.",
        input: SCAN_SCHEMA,
        execute: async (input, context) => {
          const args = input as ScanInput
          const root = resolve(ctx.location.directory, args.path ?? ".")
          const repo = loadRepo(root)
          const names = new Set(repo.plugins.map((plugin) => plugin.name))
          const unknown = (args.plugins ?? []).filter((name) => !names.has(name))
          if (unknown.length > 0) {
            return { content: `plugin_audit_scan: no plugin directory ${unknown.join(", ")} under ${root}/plugins`, metadata: { exit: 2 } }
          }
          const scoped = {
            ...repo,
            plugins: args.plugins === undefined ? repo.plugins : repo.plugins.filter((plugin) => args.plugins?.includes(plugin.name)),
          }
          const memo = new Map<string, ReturnType<typeof queryRegistry>>()
          const lookup: Lookup | undefined =
            args.offline === true
              ? undefined
              : (name, installed) => {
                  const key = `${name}@${installed}`
                  let found = memo.get(key)
                  if (found === undefined) {
                    found = queryRegistry("npm", name, installed, undefined, context.signal)
                    memo.set(key, found)
                  }
                  return found
                }
          const findings = await runAudit(scoped, root, {
            categories: args.categories,
            lookup,
            git: args.git,
            signal: context.signal,
          })
          const { content, counts } = formatReport(findings)
          return { content, metadata: { findings, counts } }
        },
      })
    })
    const skills = await registerSkills(ctx.skill, [SKILL_PATH])
    return async () => {
      await skills.dispose()
      await tools.dispose()
    }
  },
})
