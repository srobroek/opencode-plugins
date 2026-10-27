#!/usr/bin/env bun
/**
 * Fail when a shipped agent (`plugins/<name>/agents/*.md`) does not declare a model-roles
 * tier in its `x-opencode-model-role` request header, declares a value that is neither a
 * tier nor an accepted old role name, or pins a model in a plugin that does not treat it as a fallback. A plugin's
 * `agents/roles.json` fragment, when present, must match the headers.
 *
 *   bun scripts/check-agent-roles.ts           check plugins/*
 *   bun scripts/check-agent-roles.ts <files>   check the named agent files
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { isModelRole, MODEL_ROLE_HEADER, MODEL_TIERS } from "../plugins/lib/src/model-roles.ts"

export type Finding = { file: string; reason: string }

/** Plugins whose agent `model` is a fallback, applied only when model-roles is absent. */
export const FALLBACK_MODEL_PLUGINS = ["delivery"]

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** The role an agent file declares, or a finding. */
export function checkAgent(file: string, text: string, allowModel: boolean): { role?: string; findings: Finding[] } {
  const match = FRONTMATTER.exec(text.replace(/^\uFEFF/, ""))
  if (!match) return { findings: [{ file, reason: "no frontmatter" }] }
  let data: Record<string, unknown>
  try {
    const parsed = Bun.YAML.parse(match[1] ?? "")
    data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch (error) {
    return { findings: [{ file, reason: `frontmatter does not parse: ${(error as Error).message}` }] }
  }
  const findings: Finding[] = []
  const headers = (data.request as { headers?: Record<string, unknown> } | undefined)?.headers
  const role = headers?.[MODEL_ROLE_HEADER]
  if (role === undefined) findings.push({ file, reason: `no request.headers.${MODEL_ROLE_HEADER}` })
  else if (!isModelRole(role))
    findings.push({ file, reason: `unknown model tier ${JSON.stringify(role)}; use one of ${MODEL_TIERS.join(", ")}` })
  if (data.model !== undefined && !allowModel)
    findings.push({ file, reason: "pins a model; declare a tier and let the agent inherit without model-roles" })
  return { ...(isModelRole(role) ? { role } : {}), findings }
}

/** Compare a plugin's `agents/roles.json` fragment with the roles its agent files declare. */
export function checkFragment(file: string, text: string, roles: Record<string, string>): Finding[] {
  const fragment = (JSON.parse(text) as { agents?: Record<string, string> }).agents ?? {}
  const findings: Finding[] = []
  for (const id of new Set([...Object.keys(fragment), ...Object.keys(roles)])) {
    if (fragment[id] !== roles[id])
      findings.push({ file, reason: `${id}: fragment says ${fragment[id] ?? "nothing"}, agent header says ${roles[id] ?? "nothing"}` })
  }
  return findings
}

function pluginOf(file: string): string {
  const parts = path.resolve(file).split(path.sep)
  const at = parts.lastIndexOf("agents")
  return at > 0 ? (parts[at - 1] ?? "") : ""
}

export function checkFiles(root: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = []
  const byPlugin = new Map<string, Record<string, string>>()
  for (const file of files) {
    const name = path.relative(root, path.resolve(file))
    const plugin = pluginOf(file)
    const result = checkAgent(name, readFileSync(file, "utf8"), FALLBACK_MODEL_PLUGINS.includes(plugin))
    findings.push(...result.findings)
    const roles = byPlugin.get(plugin) ?? {}
    if (result.role) roles[path.basename(file, ".md")] = result.role
    byPlugin.set(plugin, roles)
  }
  for (const [plugin, roles] of byPlugin) {
    const fragment = path.join(root, "plugins", plugin, "agents", "roles.json")
    if (existsSync(fragment))
      findings.push(...checkFragment(path.relative(root, fragment), readFileSync(fragment, "utf8"), roles))
  }
  return findings
}

/** Every `plugins/<name>/agents/*.md`, sorted. */
export function shippedAgents(pluginsDir: string): string[] {
  const files: string[] = []
  for (const plugin of readdirSync(pluginsDir).sort()) {
    const dir = path.join(pluginsDir, plugin, "agents")
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).sort()) if (entry.endsWith(".md")) files.push(path.join(dir, entry))
  }
  return files
}

function main(argv: string[]): number {
  const root = path.resolve(import.meta.dir, "..")
  const files = argv.length > 0 ? argv : shippedAgents(path.join(root, "plugins"))
  const findings = checkFiles(root, files)
  for (const finding of findings) console.error(`${finding.file}: ${finding.reason}`)
  if (findings.length > 0) {
    console.error(`check-agent-roles: ${findings.length} finding(s)`)
    return 1
  }
  console.log(`check-agent-roles: ${files.length} agent(s) declare a model tier`)
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
