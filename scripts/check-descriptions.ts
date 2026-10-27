#!/usr/bin/env bun
/**
 * Keep what our plugins add to every model request small. Fails when:
 *
 * - a tool's first description line runs past TOOL_FIRST_LINE characters (Code Mode
 *   lists only that line, cut at 120), or its input schema past SCHEMA characters
 *   (CODEMODE_SCHEMA for a Code Mode tool, whose schema reaches the model only through
 *   `search` or as a catalog signature, never in every request);
 * - a tool opts out of Code Mode (`codemode: false`) without a
 *   `check-descriptions: direct <reason>` comment in the plugin's source;
 * - a skill description runs past SKILL_DESCRIPTION, or an agent description past
 *   AGENT_DESCRIPTION (both are listed on every request);
 * - an `instructions/*.md` block a context hook adds to the system prompt runs past
 *   CONTEXT_BLOCK characters.
 *
 * Tools are read by running each plugin's `setup` against the in-memory fake context, so
 * no host, model or network is involved; everything else is read from the files.
 *
 *   bun scripts/check-descriptions.ts
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseSkillFile } from "../plugins/lib/src/skill-files.ts"
import { createFakeContext } from "../plugins/lib/src/testing.ts"

export const TOOL_FIRST_LINE = 120
export const SCHEMA = 1500
export const CODEMODE_SCHEMA = 3000
export const SKILL_DESCRIPTION = 160
export const AGENT_DESCRIPTION = 150
export const CONTEXT_BLOCK = 1000

/** Findings that are accepted for now, by `<kind>:<name>`, each with the reason. */
export const EXEMPT: Record<string, string> = {
  "block:speckit/speckit-workflow.md":
    "added only in SpecKit repositories, and its MUST rules redirect the upstream /speckit.* skills on every turn",
}

export const DIRECT_COMMENT = /check-descriptions:\s*direct\s+\S/

export type Finding = { key: string; where: string; reason: string }

export type ToolInfo = {
  name: string
  description?: unknown
  input?: unknown
  options?: { codemode?: boolean }
}

/** Findings for one registered tool. `direct` says the plugin source justifies `codemode: false`. */
export function checkTool(plugin: string, tool: ToolInfo, direct: boolean): Finding[] {
  const key = `tool:${tool.name}`
  const where = `plugins/${plugin} tool ${tool.name}`
  const findings: Finding[] = []
  const first = String(tool.description ?? "").split("\n", 1)[0]?.trim() ?? ""
  if (first.length > TOOL_FIRST_LINE)
    findings.push({
      key,
      where,
      reason: `first description line is ${first.length} characters (max ${TOOL_FIRST_LINE}); move detail to later lines`,
    })
  const schema = JSON.stringify(tool.input ?? {}).length
  const limit = tool.options?.codemode === false ? SCHEMA : CODEMODE_SCHEMA
  if (schema > limit)
    findings.push({ key, where, reason: `input schema is ${schema} characters (max ${limit}); trim property descriptions` })
  if (tool.options?.codemode === false && !direct)
    findings.push({
      key,
      where,
      reason: "codemode: false puts the full schema in every request; justify it with a `check-descriptions: direct <reason>` comment",
    })
  return findings
}

/** Findings for one `SKILL.md`. */
export function checkSkill(file: string, text: string): Finding[] {
  const skill = parseSkillFile(text)
  const length = skill.description?.length ?? 0
  return length > SKILL_DESCRIPTION
    ? [{ key: `skill:${skill.name}`, where: file, reason: `description is ${length} characters (max ${SKILL_DESCRIPTION})` }]
    : []
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Findings for one agent file. */
export function checkAgent(file: string, text: string): Finding[] {
  const data = Bun.YAML.parse(FRONTMATTER.exec(text.replace(/^\uFEFF/, ""))?.[1] ?? "") as { description?: unknown } | null
  const length = typeof data?.description === "string" ? data.description.length : 0
  return length > AGENT_DESCRIPTION
    ? [{ key: `agent:${path.basename(file, ".md")}`, where: file, reason: `description is ${length} characters (max ${AGENT_DESCRIPTION})` }]
    : []
}

/** Findings for one context-hook instructions block. */
export function checkBlock(plugin: string, name: string, text: string): Finding[] {
  const length = text.trim().length
  return length > CONTEXT_BLOCK
    ? [
        {
          key: `block:${plugin}/${name}`,
          where: `plugins/${plugin}/instructions/${name}`,
          reason: `context block is ${length} characters (max ${CONTEXT_BLOCK}); move detail into a skill`,
        },
      ]
    : []
}

/** Drop the exempt findings, and report an exemption that no longer matches a finding. */
export function unexempted(findings: readonly Finding[], exempt: Record<string, string> = EXEMPT): Finding[] {
  const keys = new Set(findings.map((finding) => finding.key))
  const stale = Object.keys(exempt)
    .filter((key) => !keys.has(key))
    .map((key) => ({ key, where: "scripts/check-descriptions.ts", reason: `exemption ${key} matches nothing; remove it` }))
  return [...findings.filter((finding) => exempt[finding.key] === undefined), ...stale]
}

function files(directory: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(keep)
    .sort()
    .map((name) => path.join(directory, name))
}

function sources(directory: string): string[] {
  return files(directory, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
}

/** Stand-ins for the context domains the fake does not cover, so every plugin's setup runs. */
function complete(context: Record<string, unknown>): void {
  const registration = { dispose: async () => {} }
  context.rpc ??= { register: async () => ({ ...registration, events: { emit: async () => {} } }) }
  context.worktree ??= { transform: async () => registration }
  context.model ??= {}
  const model = context.model as Record<string, unknown>
  model.list ??= async () => ({ data: [] })
  model.default ??= async () => ({ data: undefined })
  model.transform ??= async (callback: (editor: unknown) => void) => {
    callback({ provider: { list: () => [] } })
    return registration
  }
}

async function pluginTools(root: string, plugin: string, directory: string): Promise<ToolInfo[]> {
  const entry = path.join(root, plugin, "src", "index.ts")
  if (!existsSync(entry)) return []
  const module = (await import(entry)) as { default?: { setup?: (context: unknown) => Promise<unknown> } }
  if (typeof module.default?.setup !== "function") return []
  const fake = createFakeContext({ directory })
  complete(fake.context as unknown as Record<string, unknown>)
  const cleanup = await module.default.setup(fake.context)
  const tools = [...fake.tools.values()] as unknown as ToolInfo[]
  if (typeof cleanup === "function") await (cleanup as () => Promise<void>)()
  return tools
}

export async function checkPlugins(root: string): Promise<Finding[]> {
  const findings: Finding[] = []
  const scratch = mkdtempSync(path.join(tmpdir(), "check-descriptions-"))
  try {
    for (const plugin of readdirSync(root).sort()) {
      if (plugin === "lib" || !existsSync(path.join(root, plugin, "package.json"))) continue
      const direct = sources(path.join(root, plugin, "src")).some((file) => DIRECT_COMMENT.test(readFileSync(file, "utf8")))
      for (const tool of await pluginTools(root, plugin, scratch)) findings.push(...checkTool(plugin, tool, direct))
      for (const skill of files(path.join(root, plugin, "skills"), () => true)) {
        const file = path.join(skill, "SKILL.md")
        if (existsSync(file)) findings.push(...checkSkill(file, readFileSync(file, "utf8")))
      }
      for (const file of files(path.join(root, plugin, "agents"), (name) => name.endsWith(".md")))
        findings.push(...checkAgent(file, readFileSync(file, "utf8")))
      for (const file of files(path.join(root, plugin, "instructions"), (name) => name.endsWith(".md")))
        findings.push(...checkBlock(plugin, path.basename(file), readFileSync(file, "utf8")))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return findings
}

if (import.meta.main) {
  const root = path.join(import.meta.dir, "..", "plugins")
  const findings = unexempted(await checkPlugins(root))
  for (const finding of findings) console.error(`${finding.where}: ${finding.reason}`)
  if (findings.length > 0) {
    console.error(`check-descriptions: ${findings.length} finding(s)`)
    process.exit(1)
  }
  console.log("check-descriptions: tools, skills, agents and context blocks are within their limits")
  process.exit(0)
}
