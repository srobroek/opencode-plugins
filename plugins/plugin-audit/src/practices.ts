/** The practices check: the AGENTS.md conventions every shipped plugin follows. */

import { type Finding, objectAt, type PluginSnapshot } from "./model.ts"

/** Vendored from the cad-agent tag: its pins and files are not ours to change. */
const VENDORED = new Set(["cad"])
/** A model id from an older generation than the newest the repo ships. */
const STALE_MODELS = ["-4-5", "claude-3", "claude-4", "gpt-4", "gpt-5"]
const EXACT_PIN = /==\s?\d+\.\d+\.\d+|\b[\w.-]+@\d+\.\d+\.\d+\b/
const TOOL_NAME = /editor\.add\(\{\s*name:\s*"([^"]+)"/g
const LIB_IMPORT = /["']@srobroek\/opencode-lib[/"']/
const MODEL_LINE = /^model:\s*"?([^"\s#]+)/m

/** The `exports` targets: a bare string is the "." entry. */
function exportTargets(manifest: Record<string, unknown>): string[] {
  const exports = manifest.exports
  if (typeof exports === "string") return [exports]
  return Object.values(objectAt(manifest, "exports")).filter((target): target is string => typeof target === "string")
}

function exportsMain(manifest: Record<string, unknown>): string | undefined {
  const exports = manifest.exports
  return typeof exports === "string" ? exports : (objectAt(manifest, "exports")["."] as string | undefined)
}

/**
 * Findings for one plugin. Internal packages that ship no dist bundle (such as lib) are
 * skipped; every other plugin is held to the packaging rules.
 */
export function checkPractices(plugin: PluginSnapshot): Finding[] {
  const { name, manifest } = plugin
  const internal = objectAt(manifest, "opencode-plugins").scope === "internal"
  if (internal && !exportTargets(manifest).some((target) => target.startsWith("./dist/"))) return []
  const base = { category: "practices", plugin: name, file: `plugins/${name}/package.json` } as const
  const findings: Finding[] = []
  const error = (code: string, message: string, file: string = base.file) =>
    findings.push({ ...base, severity: "error", code, message, file })
  const warn = (code: string, message: string, file: string) =>
    findings.push({ ...base, severity: "warn", code, message, file })

  if (manifest.private !== true) error("private", 'package.json must set "private": true')
  if (manifest.type !== "module") error("type", 'package.json must set "type": "module"')
  const main = exportsMain(manifest)
  if (main !== undefined && main !== "./dist/index.js") error("exports", 'exports["."] must be "./dist/index.js"')
  const files = Array.isArray(manifest.files) ? (manifest.files as string[]) : []
  // Each dist export has a root shim (index.js, tui.js, ...) that OpenCode loads by file name.
  const shims = Object.entries(objectAt(manifest, "exports"))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].startsWith("./dist/"))
    .map(([key]) => (key === "." ? "index.js" : `${key.replace(/^\.\//, "")}.js`))
  const required = ["dist", ...shims, ...(plugin.hasSkillsDir ? ["skills"] : []), ...(plugin.hasAgentsDir ? ["agents"] : [])]
  for (const entry of required) {
    if (!files.includes(entry)) error("files", `"files" must include "${entry}"`)
  }
  const peer = objectAt(manifest, "peerDependencies")["@opencode/plugin"]
  const optional = objectAt(objectAt(manifest, "peerDependenciesMeta"), "@opencode/plugin").optional
  if (peer === undefined || optional !== true) error("peer", '@opencode/plugin must be an optional peerDependency')
  const scripts = objectAt(manifest, "scripts")
  for (const hook of ["prepare", "prepack"]) {
    if (hook in scripts) error("lifecycle", `scripts.${hook} is not allowed; the bundle is committed`)
  }

  const sources = plugin.src
  if (sources.some((file) => LIB_IMPORT.test(file.text)) && objectAt(manifest, "devDependencies")["@srobroek/opencode-lib"] !== "workspace:*") {
    error("lib-dep", '@srobroek/opencode-lib must be a "workspace:*" devDependency')
  }

  // The plugin id appears as a literal in src: an id: property, a contentPlugin("...") argument or a constant.
  const ids = sources.flatMap((file) => [...file.text.matchAll(/["'`](srobroek\.[a-z0-9-]+)["'`]/g)].map((m) => m[1] as string))
  if (ids.length === 0) error("plugin-id-missing", 'no "srobroek.<name>" id literal in src/')
  else if (!ids.includes(`srobroek.${name}`))
    error("plugin-id", `plugin id ${ids[0]} must be srobroek.${name}`, `plugins/${name}/src`)

  const prefix = `${name.replaceAll("-", "_")}_`
  for (const file of sources) {
    for (const match of file.text.matchAll(TOOL_NAME)) {
      if (!match[1]?.startsWith(prefix)) warn("tool-name", `tool ${match[1]} should start with ${prefix}`, file.path)
    }
  }

  if (!VENDORED.has(name)) {
    for (const file of plugin.skills) {
      if (EXACT_PIN.test(file.text)) warn("exact-pin", "exact version pin in a skill; state the minimum or the command without one", file.path)
    }
  }

  for (const agent of plugin.agents) {
    const model = MODEL_LINE.exec(agent.text)?.[1]
    if (model !== undefined && STALE_MODELS.some((stale) => model.includes(stale))) {
      warn("stale-model", `model ${model} is an older generation; use the current tier or model`, agent.path)
    }
  }
  return findings
}
