// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude placeholders are intentionally literal.
/**
 * Pure converters from Claude Code plugin files to OpenCode V2 shapes. Nothing here
 * touches the plugin context; `load.ts` reads files and `index.ts` registers results.
 */

import { readFileSync } from "node:fs"
import type { Skill } from "@opencode/plugin"
import type { AgentFile, AgentPermission } from "@srobroek/opencode-lib/agent-files"
import { type McpServers, parseMcpJson } from "@srobroek/opencode-lib/mcp"
import { MODEL_ROLE_HEADER, type ModelTier } from "@srobroek/opencode-lib/model-roles"
import { wildcardMatch } from "@srobroek/opencode-lib/patterns"
import { skillInfo } from "@srobroek/opencode-lib/skill-files"

export type Diagnostic = { where: string; message: string }

/** What an agent without a `tools:` list gets: the session's own permissions, or nothing. */
export type UntypedAgents = "inherit" | "deny"

/** Claude tool name → OpenCode permission action. Anything else is dropped, never allowed. */
export const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  Bash: "shell",
  Read: "read",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  Glob: "glob",
  Grep: "grep",
  LS: "glob",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Task: "subagent",
  Agent: "subagent",
  Skill: "skill",
  AskUserQuestion: "question",
}

/** Code Mode runs MCP tools through `execute`, so an agent allowed an MCP tool needs it too. */
export const CODE_MODE_ACTION = "execute"

/** Patterns OpenCode asks about by default before reading or editing; restated after every grant. */
export const SENSITIVE_PATTERNS: readonly string[] = ["*.env", "*.env.*"]

/** Actions whose grants get {@link SENSITIVE_PATTERNS} asks after them. */
const FILE_ACTIONS: ReadonlySet<string> = new Set(["read", "edit"])

/** Whether a pattern has no wildcard, so it names exactly one value. */
const literal = (pattern: string) => !/[*?]/.test(pattern)

/** A pattern for the overlap of two patterns; `exact` when it matches nothing outside the overlap. */
export type Overlap = { pattern: string; exact: boolean }

/**
 * A pattern inside `grant` that covers everything `grant` and `other` both match, or
 * undefined when they cannot overlap. When the overlap cannot be written exactly, the
 * pattern is `grant` itself (`exact: false`): wider than the overlap, never outside `grant`.
 */
export function overlap(grant: string, other: string): Overlap | undefined {
  if (grant === "*" || grant === other) return { pattern: other, exact: true }
  if (other === "*") return { pattern: grant, exact: true }
  if (literal(grant)) return wildcardMatch(grant, other) ? { pattern: grant, exact: true } : undefined
  if (literal(other)) return wildcardMatch(other, grant) ? { pattern: other, exact: true } : undefined
  // `P*` and `*S` overlap exactly in `P*S` (either way round), unless a match of S could start inside P.
  const joined = (left: string, right: string) => {
    if (!left.endsWith("*") || !right.startsWith("*")) return undefined
    const prefix = left.replace(/\*+$/, "")
    const head = right.slice(1).split(/[*?]/)[0] ?? ""
    const straddles = [...prefix].some((_, at) => {
      const suffix = prefix.slice(at)
      return suffix.startsWith(head) || head.startsWith(suffix)
    })
    return literal(prefix) && head !== "" && !straddles ? left + right.slice(1) : undefined
  }
  const both = joined(grant, other) ?? joined(other, grant)
  if (both !== undefined) return { pattern: both, exact: true }
  // Literal heads or tails that disagree mean nothing can match both.
  const [headA, headB] = [grant.split(/[*?]/)[0] ?? "", other.split(/[*?]/)[0] ?? ""]
  const [tailA, tailB] = [grant.split(/[*?]/).at(-1) ?? "", other.split(/[*?]/).at(-1) ?? ""]
  if (!headA.startsWith(headB) && !headB.startsWith(headA)) return undefined
  if (!tailA.endsWith(tailB) && !tailB.endsWith(tailA)) return undefined
  const prefixOf = (pattern: string) => (/^[^*?]*\*$/.test(pattern) ? pattern.slice(0, -1) : undefined)
  const [mine, theirs] = [prefixOf(grant), prefixOf(other)]
  if (mine !== undefined && theirs !== undefined) {
    if (mine.startsWith(theirs)) return { pattern: grant, exact: true }
    if (theirs.startsWith(mine)) return { pattern: other, exact: true }
    return undefined
  }
  return { pattern: grant, exact: false }
}

const MODEL_ALIASES: Readonly<Record<string, ModelTier>> = { haiku: "cheap", sonnet: "standard", opus: "strong" }

/** Static, per-agent note: the prompt names Claude tools; these are the OpenCode ones. */
export const TOOL_NOTE =
  "Tool names: this prompt was written for Claude Code. In OpenCode use Bash→shell, Read→read, " +
  "Edit/MultiEdit→edit, Write→write, Grep→grep, Glob→glob, Task/Agent→subagent, WebFetch→webfetch, " +
  "WebSearch→websearch, Skill→skill, AskUserQuestion→question, and mcp__<server>__<tool>→<server>_<tool> " +
  "(through execute in Code Mode). TodoWrite and plan-mode tools have no equivalent here."

const CLAUDE_ONLY_TOOLS = [
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "EnterPlanMode",
  "ExitPlanMode",
  "NotebookEdit",
  "BashOutput",
  "KillShell",
  "SlashCommand",
]

export function rewriteRoot(content: string, root: string): string {
  return content.replaceAll("${CLAUDE_PLUGIN_ROOT}", () => root)
}

export function markdown(text: string): { fields: Record<string, unknown>; body: string } {
  const source = text.replace(/^\uFEFF/, "")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { fields: {}, body: source }
  const fields = Bun.YAML.parse(match[1] ?? "") ?? {}
  if (typeof fields !== "object" || Array.isArray(fields)) throw new Error("frontmatter must be a map")
  return { fields: fields as Record<string, unknown>, body: source.slice(match[0].length) }
}

/** A comma-separated string or a string list; `null` (an empty YAML key) is no list. */
export function strings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string")
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.map((part) => part.trim())
  throw new Error("expected a string or string list")
}

export function contentDiagnostics(content: string, where: string): Diagnostic[] {
  const issues: Diagnostic[] = []
  for (const token of CLAUDE_ONLY_TOOLS)
    if (new RegExp(`\\b${token}\\b`).test(content))
      issues.push({ where, message: `Claude-only tool reference: ${token}; no OpenCode equivalent` })
  if (content.includes("~/.claude/plugins") || content.includes("${HOME}/.claude/plugins"))
    issues.push({ where, message: "Hard-coded Claude plugin helper path; not translated" })
  if (content.includes("skill://")) issues.push({ where, message: "skill:// URI; not translated" })
  if (/!`[^`]+`/.test(content)) issues.push({ where, message: "Claude inline shell injection; not evaluated" })
  for (const variable of ["CLAUDE_SKILL_DIR", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID"])
    if (content.includes(`\${${variable}}`)) issues.push({ where, message: `Unsupported Claude variable: ${variable}` })
  return issues
}

export function fieldDiagnostics(fields: Record<string, unknown>, supported: string[], where: string): Diagnostic[] {
  return Object.keys(fields)
    .filter((key) => !supported.includes(key))
    .map((key) => ({ where, message: `Unsupported frontmatter: ${key}` }))
}

/** The plugin a tool spec belongs to, for `mcp__plugin_<plugin>_<server>__<tool>` names. */
export type ToolScope = { plugin: string }

/** OpenCode normalizes MCP server and tool identifiers for model/tool names. Verified on V2.2.1. */
export function mcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

const RULE = /^([A-Za-z][\w]*)(?:\((.*)\))?$/s

/**
 * The permission actions and resource one Claude tool spec grants: `Bash`, `Bash(git:*)`,
 * `Read(src/**)`, `mcp__server__tool`, `mcp__server__*`, `mcp__server` or
 * `mcp__plugin_<plugin>_<server>__<tool>`. Returns an error for anything unknown.
 */
export function mapTool(spec: string, scope: ToolScope): { rules: AgentPermission[] } | { error: string } {
  if (spec.startsWith("mcp__")) {
    const rest = spec.slice(5)
    const split = rest.indexOf("__")
    let server = split < 0 ? rest : rest.slice(0, split)
    const tool = split < 0 ? "*" : rest.slice(split + 2) || "*"
    const prefix = `plugin_${scope.plugin}_`
    if (server.startsWith(prefix)) server = server.slice(prefix.length)
    if (!server) return { error: `Malformed MCP tool name: ${spec}` }
    return {
      rules: [
        { action: `${mcpName(server)}_${tool === "*" ? "*" : mcpName(tool)}`, resource: "*", effect: "allow" },
        { action: CODE_MODE_ACTION, resource: "*", effect: "allow" },
      ],
    }
  }
  const match = RULE.exec(spec.trim())
  const action = match ? TOOL_ACTIONS[match[1] ?? ""] : undefined
  if (!match || !action) return { error: `Unknown Claude tool: ${spec}; dropped` }
  let resource = match[2]?.trim() || "*"
  // Claude's `Bash(git:*)` prefix form; OpenCode matches the command text with a wildcard.
  if (action === "shell") resource = resource.replace(/:\*$/, " *")
  return { rules: [{ action, resource, effect: "allow" }] }
}

/** Drop repeated rules, keeping each one's last position: the last match decides. */
const unique = (rules: AgentPermission[]): AgentPermission[] =>
  rules.filter(
    (rule, at) =>
      rules.findLastIndex((other) => other.action === rule.action && other.resource === rule.resource && other.effect === rule.effect) === at,
  )

/** Ask rules for the sensitive files inside each read or edit grant. */
export function sensitiveAsks(grants: readonly AgentPermission[]): AgentPermission[] {
  return grants.flatMap((grant) =>
    grant.effect !== "allow" || !FILE_ACTIONS.has(grant.action)
      ? []
      : SENSITIVE_PATTERNS.flatMap((pattern) => {
          const resource = overlap(grant.resource, pattern)
          return resource === undefined ? [] : [{ action: grant.action, resource: resource.pattern, effect: "ask" as const }]
        }),
  )
}

/**
 * Combine the rules an agent already has (OpenCode's defaults and the user's config) with
 * imported ones so that, for every call, the result is the stricter of the two policies:
 *
 * 1. the existing rules, then the imported ones (whose `* deny` closes everything else);
 * 2. every existing rule again, in order, projected onto each imported allow it overlaps,
 *    so inside a grant the user's own last match decides. Deny and ask projections may be
 *    wider than the overlap (stricter, still inside the grant); an allow is restated only
 *    when its projection is exact, so it never reopens something the user restricts;
 * 3. the sensitive-file asks for the imported read and edit grants, then any projected
 *    deny restated inside them, so an ask never loosens a user deny.
 *
 * Without imported allows (an inheriting agent) nothing is reopened: the existing rules
 * keep their order and imported denies follow them.
 */
export function intersectPermissions(existing: readonly AgentPermission[], imported: readonly AgentPermission[]): AgentPermission[] {
  const grants = imported.filter((rule) => rule.effect === "allow")
  if (grants.length === 0) return unique([...existing, ...imported])
  const projected = existing.flatMap((rule) =>
    grants.flatMap((grant) => {
      const action = overlap(grant.action, rule.action)
      const resource = action && overlap(grant.resource, rule.resource)
      if (!action || !resource) return []
      if (rule.effect === "allow" && !(action.exact && resource.exact)) return []
      return [{ action: action.pattern, resource: resource.pattern, effect: rule.effect }]
    }),
  )
  // Sensitive-file asks last; a user deny on such a file is restated after them, inside the ask.
  const asks = sensitiveAsks(grants)
  const denies = projected
    .filter((rule) => rule.effect === "deny")
    .flatMap((rule) =>
      asks.flatMap((ask) => {
        const action = overlap(ask.action, rule.action)
        const resource = action && overlap(ask.resource, rule.resource)
        return action && resource ? [{ action: action.pattern, resource: resource.pattern, effect: "deny" as const }] : []
      }),
    )
  const boundary = imported.filter((rule) => rule.effect === "deny" && !(rule.action === "*" && rule.resource === "*"))
  return unique([...existing, ...imported, ...projected, ...asks, ...denies, ...boundary])
}

/** Exact runtime intersection, also covering wildcard overlaps that cannot be expressed in a single static rule. */
export function restrictedEffect(
  current: AgentPermission["effect"],
  existing: readonly AgentPermission[],
  imported: readonly AgentPermission[],
  action: string,
  resources: readonly string[],
): AgentPermission["effect"] {
  const rank = { allow: 0, ask: 1, deny: 2 } as const
  let result = current
  for (const resource of resources) {
    for (const rules of [existing, imported]) {
      if (rules.length === 0) continue
      const effect = rules.findLast((rule) => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource))?.effect ?? "ask"
      if (rank[effect] > rank[result]) result = effect
    }
  }
  return result
}

/**
 * Fail-closed permissions for a Claude `tools:` list: deny everything, then allow each
 * mapped tool. Unknown names are dropped with a diagnostic. `disallowedTools` become denies
 * after the allows. Without a list, `untyped` decides: inherit (no rules) or deny all.
 */
export function toolPermissions(
  tools: string[] | undefined,
  disallowed: string[] | undefined,
  scope: ToolScope,
  untyped: UntypedAgents,
  where: string,
): { permissions: AgentPermission[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const permissions: AgentPermission[] = []
  if (tools !== undefined) {
    permissions.push({ action: "*", resource: "*", effect: "deny" })
    for (const tool of tools) {
      const mapped = mapTool(tool, scope)
      if ("error" in mapped) diagnostics.push({ where, message: mapped.error })
      else permissions.push(...mapped.rules)
    }
    // Keep OpenCode's sensitive-file prompts inside every read or edit grant, which would otherwise override them.
    permissions.push(...sensitiveAsks(permissions))
    // Deny-first also denies external directories; asking keeps referenced plugin files reachable.
    if (permissions.length > 1) permissions.push({ action: "external_directory", resource: "*", effect: "ask" })
  } else if (untyped === "deny") {
    permissions.push({ action: "*", resource: "*", effect: "deny" })
    diagnostics.push({ where, message: "No tools declared; agent is deny-all (untypedAgents: deny)" })
  }
  for (const tool of disallowed ?? []) {
    const mapped = mapTool(tool, scope)
    if ("error" in mapped) diagnostics.push({ where, message: `disallowedTools: ${mapped.error}` })
    // The Code Mode `execute` allow stays: other MCP tools may still need it.
    else permissions.push(...mapped.rules.filter((rule) => rule.action !== CODE_MODE_ACTION).map((rule) => ({ ...rule, effect: "deny" as const })))
  }
  return { permissions: unique(permissions), diagnostics }
}

/**
 * The model-roles tier for a Claude `model:` value. `inherit` and no value mean none;
 * a full model id naming haiku, sonnet or opus maps to that family's tier, reported.
 */
export function modelTier(model: unknown, where: string): { tier?: ModelTier; diagnostic?: Diagnostic } {
  if (model === undefined || model === null || model === "inherit") return {}
  if (typeof model !== "string") return { diagnostic: { where, message: "model must be a string; inherits session model" } }
  const alias = MODEL_ALIASES[model]
  if (alias) return { tier: alias }
  const family = Object.keys(MODEL_ALIASES).find((name) => model.toLowerCase().includes(name))
  if (family)
    return {
      tier: MODEL_ALIASES[family],
      diagnostic: { where, message: `Pinned model ${model} mapped to tier ${MODEL_ALIASES[family]}; no model pinned` },
    }
  return { diagnostic: { where, message: `Unsupported model ${model}; inherits session model` } }
}

export type AgentSettings = { untypedAgents: UntypedAgents; toolNote: boolean }

const AGENT_FIELDS = ["name", "description", "tools", "disallowedTools", "model", "color"]

/** Convert one Claude agent file to the lib's agent shape. The id is `<plugin>:<name>`. */
export function convertAgent(
  text: string,
  file: { plugin: string; name: string; root: string },
  settings: AgentSettings,
): { agent: AgentFile; diagnostics: Diagnostic[] } {
  const { fields, body } = markdown(text)
  const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : file.name
  const id = `${file.plugin}:${name}`
  const prompt = rewriteRoot(body, file.root).trim()
  const diagnostics = [...fieldDiagnostics(fields, AGENT_FIELDS, id), ...contentDiagnostics(prompt, id)]
  const access = toolPermissions(strings(fields.tools), strings(fields.disallowedTools), { plugin: file.plugin }, settings.untypedAgents, id)
  diagnostics.push(...access.diagnostics)
  const model = modelTier(fields.model, id)
  if (model.diagnostic) diagnostics.push(model.diagnostic)
  return {
    agent: {
      id,
      mode: "subagent",
      system: settings.toolNote ? `${prompt}\n\n${TOOL_NOTE}` : prompt,
      permissions: access.permissions,
      ...(typeof fields.description === "string" ? { description: fields.description.trim() } : {}),
      ...(model.tier ? { request: { headers: { [MODEL_ROLE_HEADER]: model.tier } } } : {}),
    },
    diagnostics,
  }
}

export type CommandFile = { name: string; description?: string; template: string }

/** Convert one Claude command file. `name` is `<plugin>:<relative path without .md, `/` as `:`>`. */
export function convertCommand(text: string, name: string, root: string): { command: CommandFile; diagnostics: Diagnostic[] } {
  const { fields, body } = markdown(text)
  const template = rewriteRoot(body, root)
  return {
    command: { name, template, ...(typeof fields.description === "string" ? { description: fields.description.trim() } : {}) },
    diagnostics: [...fieldDiagnostics(fields, ["description", "argument-hint"], name), ...contentDiagnostics(template, name)],
  }
}

/** Split arguments like a shell would for `$1`: whitespace, with single or double quotes grouping. */
export function splitArguments(text: string): string[] {
  const words: string[] = []
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3] ?? "")
  return words
}

/**
 * Expand a command template: `$ARGUMENTS` is the whole argument text, `$ARGUMENTS[N]` the
 * Nth word (from 0) and `$1`..`$9` the Nth word (from 1). Replacements are literal. With no
 * placeholder, arguments are appended.
 */
export function commandText(template: string, argumentsText: string): string {
  const words = splitArguments(argumentsText)
  const pattern = /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$([1-9])(?!\d)/g
  if (!new RegExp(pattern.source).test(template)) return argumentsText ? `${template}\n\nARGUMENTS: ${argumentsText}` : template
  return template.replace(pattern, (_, index: string | undefined, position: string | undefined) => {
    if (index !== undefined) return words[Number(index)] ?? ""
    if (position !== undefined) return words[Number(position) - 1] ?? ""
    return argumentsText
  })
}

/** A plugin skill: native metadata, then the strict YAML description when it parses; root expanded in the body. */
export function convertSkill(path: string, root: string): { skill: Skill.Info; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const original = skillInfo(path)
  let fields: Record<string, unknown> = {}
  try {
    fields = markdown(readFileSync(path, "utf8")).fields
  } catch (error) {
    diagnostics.push({ where: path, message: `Strict YAML metadata rejected; using native flat skill parser: ${String(error)}` })
  }
  const description = typeof fields.description === "string" ? fields.description.trim() : original.description
  const skill = { ...original, description, content: rewriteRoot(original.content, root) } as Skill.Info
  diagnostics.push(
    ...fieldDiagnostics(fields, ["name", "description", "metadata", "disable-model-invocation", "license", "allowed-tools"], path),
    ...contentDiagnostics(skill.content, path),
  )
  if (fields["allowed-tools"] !== undefined) diagnostics.push({ where: path, message: "Skill allowed-tools is not enforced" })
  return { skill, diagnostics }
}

/**
 * Parse a Claude `.mcp.json` (or a manifest's inline `mcpServers`) with the lib parser,
 * after normalising Claude's `type: "url"` spelling to `http`.
 */
export function parseClaudeMcp(document: unknown, where: string): McpServers {
  const value = document as { mcpServers?: unknown } | null
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: expected an object`)
  const servers = (value.mcpServers ?? {}) as Record<string, unknown>
  const normalised: Record<string, unknown> = {}
  if (servers && typeof servers === "object" && !Array.isArray(servers))
    for (const [name, server] of Object.entries(servers)) {
      const entry = server as { type?: unknown } | null
      normalised[name] = entry && typeof entry === "object" && entry.type === "url" ? { ...entry, type: "http" } : server
    }
  return parseMcpJson(JSON.stringify({ ...value, mcpServers: servers && typeof servers === "object" ? normalised : servers }), where)
}
