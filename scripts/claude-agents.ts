// Translates an OpenCode V2 agent file into a Claude Code subagent file.
//
// Claude Code reads only `name`, `description`, `tools`, `disallowedTools` and
// `maxTurns` from what an OpenCode agent declares; it ignores `permissions:`, so an
// untranslated read-only agent would get every tool. The translation never grants
// more than the OpenCode rules do:
//
//   - A rule list that matches every action (`action: "*"`) becomes a `tools:` allowlist
//     of the mapped tools whose unrestricted rule allows them.
//   - Any other rule list becomes a `disallowedTools:` denylist of the mapped tools its
//     rules deny; the rest are inherited, as they are in OpenCode.
//   - A rule restricted to some resources (a command, a path, a skill or agent name)
//     cannot be expressed per subagent in Claude Code. A restricted allow is dropped and a
//     restricted deny removes the whole tool. `ask` counts as deny on an unrestricted
//     rule and is dropped on a restricted one.
//   - Actions without a Claude Code tool (Code Mode `execute`, `question`, plugin tools,
//     `external_directory`) are dropped.
//
// Every drop is reported. The prompt body is kept verbatim.

import { parseFrontmatter } from "./convert-agent.ts"

type Effect = "allow" | "deny" | "ask"
type Rule = { action: string; resource: string; effect: Effect }

/** OpenCode permission actions and the Claude Code tools they stand for, in output order. */
export const TOOL_GROUPS: ReadonlyArray<{ actions: readonly string[]; tools: readonly string[] }> = [
  { actions: ["read"], tools: ["Read"] },
  { actions: ["grep"], tools: ["Grep"] },
  { actions: ["glob"], tools: ["Glob"] },
  { actions: ["lsp_*"], tools: ["LSP"] },
  { actions: ["edit"], tools: ["Edit", "Write", "NotebookEdit"] },
  { actions: ["shell", "bash"], tools: ["Bash"] },
  { actions: ["webfetch"], tools: ["WebFetch"] },
  { actions: ["websearch"], tools: ["WebSearch"] },
  { actions: ["subagent", "task"], tools: ["Agent"] },
  { actions: ["skill"], tools: ["Skill"] },
]

const ANY = "*"

/** A rule the translation could not carry over, and why. */
export type Dropped = { rule: string; reason: string }

export type ClaudeAgent = { id: string; contents: string; dropped: Dropped[] }

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)
}

function readRules(where: string, value: unknown): Rule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${where}: permissions must be a list`)
  return value.map((entry, index) => {
    const rule = entry as Record<string, unknown>
    const { action, resource, effect } = rule ?? {}
    if (typeof action !== "string" || typeof resource !== "string" || !["allow", "deny", "ask"].includes(String(effect)))
      throw new Error(`${where}: permissions[${index}] needs a string action and resource and an allow, deny or ask effect`)
    return { action, resource, effect: effect as Effect }
  })
}

const describeRule = (rule: Rule) =>
  rule.resource === ANY ? `${rule.effect} ${rule.action}` : `${rule.effect} ${rule.action}(${rule.resource})`

/**
 * Whether the rules leave a tool group usable, by OpenCode's last-match-wins order:
 * `allow`, `deny`, or `unset` when no rule names it.
 */
function groupVerdict(rules: readonly Rule[], actions: readonly string[], dropped: Dropped[]): "allow" | "deny" | "unset" {
  const matching = rules.filter((rule) => actions.some((action) => glob(rule.action).test(action)))
  const baseIndex = matching.findLastIndex((rule) => rule.resource === ANY)
  const base = baseIndex === -1 ? undefined : matching[baseIndex]
  let verdict: "allow" | "deny" | "unset" = base === undefined ? "unset" : base.effect === "allow" ? "allow" : "deny"
  if (base?.effect === "ask") dropped.push({ rule: describeRule(base), reason: "no per-subagent ask; denied" })
  for (const rule of matching.slice(baseIndex + 1)) {
    if (rule.effect === "allow" && verdict !== "allow")
      dropped.push({ rule: describeRule(rule), reason: "resource-restricted allow; dropped" })
    else if (rule.effect === "ask" && verdict === "allow")
      dropped.push({ rule: describeRule(rule), reason: "resource-restricted ask; dropped" })
    else if (rule.effect === "deny" && verdict === "allow") {
      dropped.push({ rule: describeRule(rule), reason: "resource-restricted deny; whole tool denied" })
      verdict = "deny"
    }
  }
  return verdict
}

const quote = (value: string) => JSON.stringify(value)

/**
 * The Claude Code subagent for one OpenCode agent file, or a thrown error when it cannot
 * be exported: a primary agent, a missing description, or no tool left in an allowlist.
 */
export function translateAgent(id: string, text: string, where = `agents/${id}.md`): ClaudeAgent {
  const { data, body } = parseFrontmatter(text)
  if (data.mode === "primary") throw new Error(`${where}: a primary agent has no Claude Code subagent equivalent`)
  const description = data.description
  if (typeof description !== "string" || !description.trim()) throw new Error(`${where}: description is required`)
  const rules = readRules(where, data.permissions)
  const dropped: Dropped[] = []
  const exclusive = rules.some((rule) => rule.action === ANY)
  const allowed: string[] = []
  const denied: string[] = []
  for (const group of TOOL_GROUPS) {
    const verdict = groupVerdict(rules, group.actions, dropped)
    if (verdict === "allow") allowed.push(...group.tools)
    else if (verdict === "deny") denied.push(...group.tools)
  }
  const unmapped = rules.filter(
    (rule) =>
      rule.action !== ANY &&
      rule.effect !== "deny" &&
      !TOOL_GROUPS.some((group) => group.actions.some((action) => glob(rule.action).test(action))),
  )
  for (const rule of unmapped) dropped.push({ rule: describeRule(rule), reason: "no Claude Code tool; dropped" })
  if (exclusive && allowed.length === 0) throw new Error(`${where}: no Claude Code tool survives the translation`)
  const lines = [
    "---",
    `# Generated by scripts/build-marketplaces.ts from ${where}. Do not edit.`,
    `name: ${id}`,
    `description: ${quote(description)}`,
  ]
  if (exclusive) lines.push(`tools: ${allowed.join(", ")}`)
  else if (denied.length > 0) lines.push(`disallowedTools: ${denied.join(", ")}`)
  const steps = data.steps
  if (typeof steps === "number" && Number.isInteger(steps) && steps > 0) lines.push(`maxTurns: ${steps}`)
  lines.push("---")
  return { id, contents: `${lines.join("\n")}\n${body}`, dropped }
}
