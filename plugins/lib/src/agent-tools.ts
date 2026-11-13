/**
 * The `tools` option of the plugins that ship agents: extra MCP tool patterns an agent may call.
 *
 * Shipped agents deny `*` first and allow a fixed list, so they cannot call MCP tools. OpenCode
 * names an MCP tool's permission action `<server>_<tool>`, so a pattern such as `context7_*`
 * allows one server's tools. The rules go after the agent's own, so the last match wins over
 * the leading `* deny`. A pattern that would match a built-in action (`shell`, `edit`, `*`,
 * `s*`) is refused: the option must not widen file, shell or subagent access.
 */

import type { AgentPermission } from "./agent-files.ts"

/** Public, read-only MCP servers every plugin's agents may call unless the option says otherwise. */
export const DEFAULT_MCP_TOOLS: readonly string[] = ["context7_*", "aws-mcp_*"]

/** Built-in permission actions the option can never grant. */
const BUILT_IN_ACTIONS: readonly string[] = [
  "shell",
  "bash",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "read",
  "grep",
  "glob",
  "execute",
  "external_directory",
  "subagent",
  "task",
  "skill",
  "question",
  "webfetch",
  "websearch",
  "todowrite",
]

function matches(value: string, pattern: string): boolean {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  return new RegExp(`^${source}$`, "s").test(value)
}

/** Why `pattern` is not allowed in the option, or undefined when it is. */
export function refusedTool(pattern: unknown): string | undefined {
  if (typeof pattern !== "string" || pattern.trim() === "") return "not a non-empty string"
  const value = pattern.trim()
  if (!/^[A-Za-z0-9_*-]+$/.test(value)) return "use only letters, digits, `_`, `-` and `*`"
  const builtIn = BUILT_IN_ACTIONS.find((action) => matches(action, value))
  if (builtIn !== undefined) return `matches the built-in action ${builtIn}`
  return undefined
}

/**
 * The patterns the `tools` option selects. Absent means the defaults; `false` or `[]` means none;
 * an array replaces the defaults. Refused entries are dropped and reported through `warn`.
 */
export function parseToolsOption(
  raw: unknown,
  warn: (message: string) => void = (message) => console.warn(message),
): string[] {
  if (raw === undefined) return [...DEFAULT_MCP_TOOLS]
  if (raw === false) return []
  if (!Array.isArray(raw)) {
    warn(`tools option ignored: expected an array of tool patterns or false, got ${typeof raw}`)
    return [...DEFAULT_MCP_TOOLS]
  }
  const kept: string[] = []
  for (const entry of raw) {
    const reason = refusedTool(entry)
    if (reason) warn(`tools option: refused ${JSON.stringify(entry)}: ${reason}`)
    else if (!kept.includes((entry as string).trim())) kept.push((entry as string).trim())
  }
  return kept
}

/** Allow rules for `patterns`, to append after an agent's own rules. */
export function toolRules(patterns: readonly string[]): AgentPermission[] {
  return patterns.map((action) => ({ action, resource: "*", effect: "allow" }))
}

/** The allow rules the plugin option `raw` selects. */
export function toolRulesFromOption(raw: unknown, warn?: (message: string) => void): AgentPermission[] {
  return toolRules(parseToolsOption(raw, warn))
}

/** `file` with `rules` after its own permissions. */
export function withToolRules<T extends { permissions: AgentPermission[] }>(
  file: T,
  rules: readonly AgentPermission[],
): T {
  return rules.length === 0 ? file : { ...file, permissions: [...file.permissions, ...rules] }
}

/** The agents that gain `rules`; every other agent registered with them is left alone. */
export type ToolGrant = { agents: readonly string[]; rules: readonly AgentPermission[] }

/** `file` with the grant's rules after its own when the grant names its id. */
export function grantTools<T extends { id: string; permissions: AgentPermission[] }>(file: T, grant?: ToolGrant): T {
  return grant !== undefined && grant.agents.includes(file.id) ? withToolRules(file, grant.rules) : file
}
