#!/usr/bin/env bun
/**
 * Convert Oh My Pi agent markdown into OpenCode V2 agent markdown.
 *
 *   bun scripts/convert-agent.ts --roles roles.json --out <dir> [--fragment <file>] [--mode subagent] [--allow-listed] <files...>
 *
 * Writes `<dir>/<id>.md` per agent plus a roles fragment for the model-roles plugin
 * ({ agents: { <id>: <role> } }, default `<dir>/roles.json`), and prints warnings. Only V2-native frontmatter keys are
 * emitted: an unknown key makes OpenCode read the file as V1, which drops `model: …#variant`
 * and moves the key into `request.body` (docs/design/model-roles.md).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

export type Mode = "subagent" | "primary" | "all"
export type Effect = "allow" | "ask" | "deny"

export interface Permission {
  action: string
  resource: string
  effect: Effect
}

/**
 * A role's default model. A string is `provider/model` or `provider/model#variant`; an
 * array is the model-roles candidate list (first concrete entry wins, `@role` chains);
 * an object names the variants the model supports so `thinking-level` can map onto one.
 */
export type RoleEntry = string | string[] | { model: string; variants?: string[] }
export type RolesConfig = Record<string, RoleEntry>

export interface ConvertOptions {
  roles: RolesConfig
  /** Agent id; defaults to the omp `name`. */
  id?: string
  mode?: Mode
  /** Emit explicit `allow` rules for listed tools; otherwise they inherit global rules. */
  allowListed?: boolean
}

export interface V2Frontmatter {
  description?: string
  mode: Mode
  model?: string
  permissions: Permission[]
}

export interface Converted {
  id: string
  role?: string
  frontmatter: V2Frontmatter
  body: string
  warnings: string[]
}

/** V2 permission actions this converter decides; everything else keeps OpenCode defaults. */
export const MANAGED_ACTIONS = ["read", "glob", "grep", "edit", "shell", "webfetch", "websearch", "subagent"] as const

const TOOL_MAP: Record<string, string[]> = {
  read: ["read"],
  grep: ["grep"],
  glob: ["glob"],
  find: ["glob"],
  edit: ["edit"],
  write: ["edit"],
  ast_edit: ["edit"],
  bash: ["shell"],
  web_search: ["websearch"],
  fetch: ["webfetch"],
  task: ["subagent"],
}

const DROPPED_TOOLS = new Set(["lsp", "ast_grep", "eval", "yield", "github"])

/** omp agent ids that have a different V2 counterpart. */
export const AGENT_MAP: Record<string, string> = { scout: "explore" }

const IGNORED_KEYS: Record<string, string> = {
  "read-summarize": "no V2 equivalent",
  autoloadSkills: "no V2 equivalent; load the skills from the prompt instead",
  blocking: "no V2 equivalent; the caller chooses foreground or background",
}

const HANDLED_KEYS = new Set(["name", "description", "model", "thinking-level", "tools", "spawns", "output"])

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { data: {}, body: text }
  const parsed = Bun.YAML.parse(match[1] ?? "")
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  return { data, body: text.slice(match[0].length) }
}

export function splitList(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",") : []
  return items.map((item) => item.trim()).filter(Boolean)
}

/** Parse an omp model field (`@role`, `@role:level`, comma fallbacks) into its first role. */
export function parseRole(model: unknown, warnings: string[]): { role?: string; level?: string } {
  const entries = splitList(model)
  const first = entries[0]
  if (!first) return {}
  if (entries.length > 1) warnings.push(`model: only the first entry (${first}) is used; dropped ${entries.slice(1).join(", ")}`)
  if (!first.startsWith("@")) {
    warnings.push(`model: ${first} is a raw selector, not a role; dropped`)
    return {}
  }
  const [role, level] = first.slice(1).split(":")
  return { role, level }
}

function candidate(roles: RolesConfig, role: string, seen: Set<string>): { model: string; variants?: string[] } | undefined {
  if (seen.has(role)) return undefined
  seen.add(role)
  const entry = roles[role]
  if (entry === undefined) return undefined
  if (typeof entry === "object" && !Array.isArray(entry)) return entry
  for (const item of typeof entry === "string" ? [entry] : entry) {
    const found = item.startsWith("@") ? candidate(roles, item.slice(1), seen) : { model: item }
    if (found) return found
  }
  return undefined
}

/** Resolve a role to the explicit default model, mapping thinking-level to a variant. */
export function resolveModel(
  roles: RolesConfig,
  role: string,
  thinking: string | undefined,
  warnings: string[],
): string | undefined {
  const target = candidate(roles, role, new Set())
  if (!target) {
    warnings.push(`model: role @${role} has no model in the roles file; agent inherits its parent's model`)
    return undefined
  }
  const [model, fixed] = target.model.split("#")
  if (fixed) {
    if (thinking && thinking !== fixed)
      warnings.push(`thinking-level: ${thinking} ignored; role @${role} pins variant #${fixed}`)
    return `${model}#${fixed}`
  }
  if (!thinking || thinking === "off") return model
  const variants = target.variants
  const variant = variants?.includes(thinking)
    ? thinking
    : thinking === "xhigh" && variants?.includes("max")
      ? "max"
      : undefined
  if (variant) return `${model}#${variant}`
  warnings.push(
    variants
      ? `thinking-level: ${model} has no variant ${thinking}; dropped`
      : `thinking-level: ${thinking} dropped; the roles file lists no variants for @${role}`,
  )
  return model
}

/** Map an omp tools CSV onto V2 permission actions. */
export function mapTools(tools: unknown, warnings: string[]): Set<string> {
  const names = splitList(tools)
  const actions = new Set<string>()
  for (const name of names) {
    const mapped = TOOL_MAP[name]
    if (mapped) for (const action of mapped) actions.add(action)
    else if (DROPPED_TOOLS.has(name)) warnings.push(`tools: ${name} has no V2 tool; dropped`)
    else warnings.push(`tools: ${name} is not a known omp builtin; left to its plugin's permission`)
  }
  // omp `read` also fetches URLs; with web_search granted, keep that reach as webfetch.
  if (actions.has("websearch") && actions.has("read")) actions.add("webfetch")
  return actions
}

export function buildPermissions(
  tools: unknown,
  spawns: unknown,
  warnings: string[],
  allowListed = false,
): Permission[] {
  const all = (action: string, effect: Effect): Permission => ({ action, resource: "*", effect })
  const children = splitList(spawns).map((id) => AGENT_MAP[id] ?? id)
  if (tools === undefined) {
    warnings.push("tools: none listed, so omp grants every tool; only subagent rules are emitted")
  }
  const actions = tools === undefined ? new Set<string>(MANAGED_ACTIONS) : mapTools(tools, warnings)
  const rules: Permission[] = []
  for (const action of MANAGED_ACTIONS) {
    if (action === "subagent" && children.length > 0) continue
    if (!actions.has(action)) rules.push(all(action, "deny"))
    else if (allowListed) rules.push(all(action, "allow"))
  }
  if (children.length > 0) {
    rules.push(all("subagent", "deny"))
    for (const id of [...new Set(children)]) rules.push({ action: "subagent", resource: id, effect: "allow" })
    warnings.push("spawns: nested subagents need experimental.subagent_depth >= 2")
  }
  return rules
}

interface JtdSchema {
  metadata?: { description?: string }
  type?: string
  enum?: string[]
  elements?: JtdSchema
  values?: JtdSchema
  properties?: Record<string, JtdSchema>
  optionalProperties?: Record<string, JtdSchema>
  nullable?: boolean
}

function describeType(schema: JtdSchema): string {
  if (schema.enum) return `one of ${schema.enum.join(", ")}`
  if (schema.elements) return `array of ${describeType(schema.elements)}`
  if (schema.values) return `map of ${describeType(schema.values)}`
  if (schema.properties || schema.optionalProperties) {
    const fields = [
      ...Object.keys(schema.properties ?? {}),
      ...Object.keys(schema.optionalProperties ?? {}).map((key) => `${key}?`),
    ]
    return `object {${fields.join(", ")}}`
  }
  if (schema.type === "boolean") return "boolean"
  if (schema.type === "timestamp") return "RFC 3339 timestamp"
  if (schema.type && /^(u?int(8|16|32)|float(32|64))$/.test(schema.type)) return "number"
  return schema.type ?? "any JSON value"
}

function example(schema: JtdSchema): unknown {
  if (schema.enum) return schema.enum.join(" | ")
  if (schema.elements) return [example(schema.elements)]
  if (schema.values) return { "<key>": example(schema.values) }
  if (schema.properties || schema.optionalProperties) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries({ ...schema.properties, ...schema.optionalProperties }))
      out[key] = example(value)
    return out
  }
  if (schema.type === "boolean") return false
  if (schema.type && /^(u?int|float)/.test(schema.type)) return 0
  return schema.type ?? null
}

/** Render a JTD `output` schema as the VERDICT-line + JSON-block report contract. */
export function reportFormat(output: unknown, warnings: string[]): string | undefined {
  if (!output || typeof output !== "object") return undefined
  const schema = output as JtdSchema
  const verdict = schema.properties?.verdict?.enum ?? schema.optionalProperties?.verdict?.enum
  if (!verdict) warnings.push("output: no verdict enum; the report has no VERDICT line")
  const lines = ["## Report format", ""]
  if (verdict)
    lines.push(
      "Begin your reply with this exact first line, before any other text:",
      "",
      "```text",
      `VERDICT: ${verdict.join("|")}`,
      "```",
      "",
    )
  lines.push(
    "End your reply with one fenced `json` block holding these fields:",
    "",
    "```json",
    JSON.stringify(example(schema), null, 2),
    "```",
    "",
  )
  const field = (key: string, value: JtdSchema, required: boolean) => {
    const note = value.metadata?.description ? `: ${value.metadata.description}` : ""
    const nullable = value.nullable ? ", nullable" : ""
    lines.push(`- \`${key}\` (${required ? "required" : "optional"}, ${describeType(value)}${nullable})${note}`)
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) field(key, value, true)
  for (const [key, value] of Object.entries(schema.optionalProperties ?? {})) field(key, value, false)
  lines.push("", "Omit optional fields that do not apply.")
  return lines.join("\n")
}

const REWRITTEN_SCHEMES = ["skill", "rule", "agent", "proc"]
/** URI tail up to whitespace, a closing quote or bracket, leaving trailing sentence punctuation out. */
const URI_REST = String.raw`[^\s\x60'")\]]*?(?=[.,;:!?]*(?:[\s\x60'")\]]|$))`

/**
 * Turn omp `skill://`, `rule://`, `agent://` and `proc://` references into plain names and
 * flag other harness URIs (`pr://`, `memory://`, …). The full prose rewrite is separate work.
 */
export function rewriteReferences(body: string, warnings: string[]): string {
  const found = new Map<string, number>()
  const out = body.replace(new RegExp(`\\b(${REWRITTEN_SCHEMES.join("|")})://(${URI_REST})`, "g"), (whole, scheme, rest) => {
    found.set(whole, (found.get(whole) ?? 0) + 1)
    return rest === "" ? scheme : rest
  })
  for (const [ref, count] of found)
    warnings.push(`body: ${ref} rewritten to a plain name${count > 1 ? ` (${count}x)` : ""}`)
  const other = new Set<string>()
  for (const match of out.matchAll(new RegExp(`\\b([a-z][a-z0-9+.-]*)://${URI_REST}`, "g"))) {
    const scheme = match[1] ?? ""
    if (!["http", "https", "ssh", "git", "file", ...REWRITTEN_SCHEMES].includes(scheme)) other.add(match[0])
  }
  for (const ref of other) warnings.push(`body: ${ref} is an omp-only URI with no V2 resolver; left as is`)
  if (/\byield\b|output schema|frontmatter output/i.test(out))
    warnings.push("body: mentions yield or the frontmatter output schema; reword for the Report format section")
  return out
}

export function convertAgent(text: string, options: ConvertOptions): Converted {
  const warnings: string[] = []
  const { data, body } = parseFrontmatter(text)
  const id = options.id ?? (typeof data.name === "string" ? data.name : undefined)
  if (!id) throw new Error("agent has no name and no id was given")
  for (const key of Object.keys(data)) {
    if (HANDLED_KEYS.has(key)) continue
    const value = splitList(data[key]).join(", ")
    warnings.push(`${key}: dropped (${IGNORED_KEYS[key] ?? "unknown omp key"})${value ? `: ${value}` : ""}`)
  }
  const { role, level } = parseRole(data.model, warnings)
  const thinking = level ?? (typeof data["thinking-level"] === "string" ? data["thinking-level"] : undefined)
  const model = role ? resolveModel(options.roles, role, thinking, warnings) : undefined
  const frontmatter: V2Frontmatter = {
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    mode: options.mode ?? "subagent",
    ...(model ? { model } : {}),
    permissions: buildPermissions(data.tools, data.spawns, warnings, options.allowListed),
  }
  if (!frontmatter.description) warnings.push("description: missing; the subagent catalog shows nothing")
  let converted = rewriteReferences(body.trim(), warnings)
  const report = reportFormat(data.output, warnings)
  if (report) converted = `${converted}\n\n${report}`
  return { id, ...(role ? { role } : {}), frontmatter, body: `${converted}\n`, warnings }
}

const quote = (value: string) => JSON.stringify(value)

export function renderAgent(agent: Converted): string {
  const fm = agent.frontmatter
  const lines = ["---"]
  if (fm.description !== undefined) lines.push(`description: ${quote(fm.description)}`)
  lines.push(`mode: ${fm.mode}`)
  if (fm.model) lines.push(`model: ${quote(fm.model)}`)
  if (fm.permissions.length === 0) lines.push("permissions: []")
  else {
    lines.push("permissions:")
    for (const rule of fm.permissions)
      lines.push(
        `  - action: ${rule.action}`,
        `    resource: ${quote(rule.resource)}`,
        `    effect: ${rule.effect}`,
      )
  }
  lines.push("---", "", agent.body)
  return lines.join("\n")
}

export function rolesFragment(agents: Converted[]): { agents: Record<string, string> } {
  const out: Record<string, string> = {}
  for (const agent of agents) if (agent.role) out[agent.id] = agent.role
  return { agents: out }
}

export interface Cli {
  roles: string
  out: string
  fragment?: string
  mode: Mode
  allowListed: boolean
  files: string[]
}

export function parseArgs(argv: string[]): Cli {
  const cli: Partial<Cli> & { files: string[] } = { files: [], mode: "subagent", allowListed: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === "--roles") cli.roles = next()
    else if (arg === "--out") cli.out = next()
    else if (arg === "--fragment") cli.fragment = next()
    else if (arg === "--mode") {
      const mode = next()
      if (mode !== "subagent" && mode !== "primary" && mode !== "all") throw new Error(`bad --mode ${mode}`)
      cli.mode = mode
    } else if (arg === "--allow-listed") cli.allowListed = true
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`)
    else cli.files.push(arg)
  }
  if (!cli.roles || !cli.out || cli.files.length === 0)
    throw new Error(
      "usage: bun scripts/convert-agent.ts --roles roles.json --out <dir> [--fragment <file>] [--mode subagent] [--allow-listed] <files...>",
    )
  return cli as Cli
}

function main(argv: string[]): number {
  const cli = parseArgs(argv)
  const roles = JSON.parse(readFileSync(cli.roles, "utf8")) as RolesConfig
  mkdirSync(cli.out, { recursive: true })
  const converted: Converted[] = []
  for (const file of cli.files) {
    const agent = convertAgent(readFileSync(file, "utf8"), {
      roles,
      mode: cli.mode,
      allowListed: cli.allowListed,
    })
    if (agent.id !== basename(file, ".md")) agent.warnings.push(`id ${agent.id} differs from filename ${basename(file)}`)
    converted.push(agent)
    const target = join(cli.out, `${agent.id}.md`)
    writeFileSync(target, renderAgent(agent))
    console.log(`${file} -> ${target}`)
    for (const warning of agent.warnings) console.warn(`  WARN ${agent.id}: ${warning}`)
  }
  const fragment = cli.fragment ?? join(cli.out, "roles.json")
  writeFileSync(fragment, `${JSON.stringify(rolesFragment(converted), null, 2)}\n`)
  console.log(`roles fragment -> ${fragment}`)
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
