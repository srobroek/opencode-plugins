import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { appendResultText } from "@srobroek/opencode-lib/shell-result"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { shellCommand } from "@srobroek/opencode-lib/tool-targets"
import { applyBump, type BumpRecord, researchProject, validOperands } from "./bump.ts"
import { persistentScannerInstall, SCANNER_ADVISORY } from "./scanner-install.ts"

export {
  applyBump,
  classify,
  compareVersions,
  detectProject,
  normalizeVersion,
  parseRequirement,
  queryRegistry,
  researchProject,
} from "./bump.ts"
export { persistentScannerInstall } from "./scanner-install.ts"

export const APPLY_ACTION = "dep_apply"
export const SKILL_PATH = fileURLToPath(new URL("../skills/dep-update/SKILL.md", import.meta.url))

const CLASS_ORDER = ["PATCH-SAFE", "MINOR-CHECK", "MAJOR-ADVISORY"]
const REPORTED = new Set(["UNRESOLVABLE", "DISCONFIRMED", "UNCHECKED"])

export type ScanSummary = { upgradable: number; skipped: number; unchecked: number }

/** The dep_scan report: upgradable bumps by class and name, then everything not classified. */
export function formatScan(records: readonly BumpRecord[], stderr: string): { text: string; summary: ScanSummary } {
  const upgradable = records.filter((r) => r.status === "OK")
  const lines: string[] = []
  for (const cls of CLASS_ORDER) {
    const bucket = upgradable.filter((r) => r.class === cls).sort((a, b) => a.name.localeCompare(b.name))
    for (const r of bucket) lines.push(`${cls.padEnd(15)} ${r.name}  ${r.installed} -> ${r.latest}  (${r.ecosystem})`)
  }
  for (const r of records) {
    if (!REPORTED.has(r.status)) continue
    lines.push(
      `${r.status.padEnd(15)} ${r.name}  ${r.installed} -> ${r.latest ?? "unknown"}  (${r.ecosystem}): ${r.reason ?? "not classified"}`,
    )
  }
  const unchecked = records.filter((r) => r.status === "UNCHECKED").length
  const skipped = records.length - upgradable.length - unchecked
  lines.push(`-- ${upgradable.length} upgradable, ${skipped} current/unresolvable, ${unchecked} unchecked --`)
  if (stderr.trim()) lines.push(stderr.trim())
  return { text: lines.join("\n"), summary: { upgradable: upgradable.length, skipped, unchecked } }
}

/** The permission resource naming one bump. */
export function bumpResource(name: string, version: string): string {
  return `${name}@${version}`
}

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string; message?: string }

/**
 * Turn an allowed dep_apply into a prompt. The default policy allows every action, so
 * without this a bump would run unconfirmed; a configured deny never reaches the hook.
 */
export function confirmBump(evaluation: Evaluation): void {
  if (evaluation.action !== APPLY_ACTION || evaluation.effect !== "allow") return
  evaluation.effect = "ask"
  evaluation.message = `Apply dependency bump ${evaluation.resources.join(", ")}? A failed or cancelled package-manager run can leave partial changes.`
}

type ScanInput = { path?: string }
type ApplyInput = { ecosystem: string; name: string; version: string; path?: string }

function projectDir(base: string, path: string | undefined): string {
  if (!path) return base
  return isAbsolute(path) ? path : resolve(base, path)
}

export default Plugin.define({
  id: "srobroek.dep-update",
  async setup(ctx) {
    const confirm = ctx.options.confirm !== false
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "dep_scan",
        description:
          "Enumerate a project's declared dependencies, query PyPI/npm for the latest versions, and " +
          "classify exact-version bumps as PATCH-SAFE, MINOR-CHECK, or MAJOR-ADVISORY. Read-only. A scan " +
          "stopped by its aggregate deadline or by cancellation returns an incomplete report (complete: false) " +
          "that lists every dependency it did not query as UNCHECKED. Rust and Go deps are advisory-only.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Project root to scan; defaults to the session directory" },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const dir = projectDir(ctx.location.directory, (input as ScanInput).path)
          // DEP_UPDATE_FIXTURE_DIR (tests only) swaps registry fetches for fixture files.
          const { exit, records, stderr, complete } = await researchProject(dir, undefined, context.signal)
          if (exit !== 0) return { content: `dep_scan failed (exit ${exit}):\n${stderr}`, metadata: { exit } }
          const { text, summary } = formatScan(records, stderr)
          return { content: text, metadata: { records, complete, summary } }
        },
      })
      editor.add({
        name: "dep_apply",
        description:
          "Apply one dependency bump via the ecosystem package manager, after a permission prompt naming " +
          "that exact bump. One call per bump. The run is bounded to 10 minutes; if it is cancelled or fails, " +
          "the result says partial changes may remain so the caller can inspect manifests and lockfiles.",
        input: {
          type: "object",
          properties: {
            ecosystem: { type: "string", description: "pypi, npm, cargo, or go" },
            name: { type: "string", description: "Package name" },
            version: { type: "string", description: "Exact target version to pin" },
            path: { type: "string", description: "Project root; defaults to the session directory" },
          },
          required: ["ecosystem", "name", "version"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { ecosystem, name, version, path } = input as ApplyInput
          const root = projectDir(ctx.location.directory, path)
          if (!validOperands(ecosystem, name, version)) {
            return {
              content: "dep_apply: unsupported ecosystem, package name, or exact version; no process started",
              metadata: { exit: 2 },
            }
          }
          context.signal.throwIfAborted()
          const resource = bumpResource(name, version)
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: APPLY_ACTION,
            resources: [resource],
            save: [resource],
            metadata: { ecosystem, name, version, project: root },
          })
          const result = await applyBump(ecosystem, name, version, root, { signal: context.signal })
          return { content: result.text, metadata: { exit: result.exit } }
        },
      })
    })
    const gate = confirm ? await ctx.permission.hook("evaluate", confirmBump) : undefined
    const advisory = await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return
      const command = shellCommand(event.tool, event.input)
      if (command === undefined || persistentScannerInstall(command) === undefined) return
      event.result = appendResultText(event.result, SCANNER_ADVISORY)
    })
    const skills = await registerSkills(ctx.skill, [SKILL_PATH])
    return async () => {
      await skills.dispose()
      await advisory.dispose()
      await gate?.dispose()
      await tools.dispose()
    }
  },
})
