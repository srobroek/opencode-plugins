// PreToolUse hook that carries an OpenCode agent's resource-restricted `ask` rules into Claude Code.
//
// A plugin subagent's own `hooks:` are ignored by Claude Code, so scripts/build-marketplaces.ts
// ships this file with each plugin that exports a guarded agent, transpiled to JavaScript and
// with no imports beyond node:* and an unconditional entry point, next to `agent-guards.json` (agent id -> guards from
// scripts/claude-agents.ts). It runs for every matched tool call and answers only for a call
// made by a guarded subagent. It fails closed: input or config it cannot read gets an `ask`.

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

type GuardRule = { resource: string; effect: "allow" | "ask" }
type GuardEntry = { tools: string[]; rules: GuardRule[] }
type Input = { agent_type?: string; tool_name?: string; tool_input?: Record<string, unknown> }
type Output = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "ask"; permissionDecisionReason: string } }

/** The tool input field that names what a rule's resource pattern matches. */
const RESOURCE_FIELD: Record<string, string> = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  Grep: "path",
  Glob: "path",
  Bash: "command",
  WebFetch: "url",
  WebSearch: "query",
  Skill: "skill",
  Agent: "subagent_type",
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "s")

const ask = (reason: string): Output => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
})

/** The answer for one tool call, or `undefined` to leave it to Claude Code. */
export function guardDecision(input: Input, config: Record<string, GuardEntry[]>): Output | undefined {
  const agent = input.agent_type
  if (!agent || !input.tool_name) return undefined
  const id = Object.keys(config).find((key) => agent === key || agent.endsWith(`:${key}`))
  if (id === undefined) return undefined
  const field = RESOURCE_FIELD[input.tool_name]
  const target = field === undefined ? undefined : input.tool_input?.[field]
  if (typeof target !== "string") return undefined
  for (const guard of config[id] ?? []) {
    if (!guard.tools.includes(input.tool_name)) continue
    const match = guard.rules.findLast((rule) => glob(rule.resource).test(target))
    if (match?.effect === "ask") return ask(`${id} must ask before ${input.tool_name} on ${target} (matches ${match.resource})`)
  }
  return undefined
}

function main(): void {
  let output: Output | undefined
  try {
    const guards = process.env.CLAUDE_AGENT_GUARDS ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-guards.json")
    output = guardDecision(JSON.parse(readFileSync(0, "utf8")) as Input, JSON.parse(readFileSync(guards, "utf8")))
  } catch (error) {
    output = ask(`agent guard failed (${error instanceof Error ? error.message : String(error)}); asking instead`)
  }
  if (output !== undefined) process.stdout.write(JSON.stringify(output))
}

// Bun runs this source directly. The generated hook script, which is only ever executed, has this
// line replaced by an unconditional `main()`: Node before 22.18 and 24.2 has no `import.meta.main`,
// and through a symlinked plugin directory `process.argv[1]` is not the module's resolved path.
if (import.meta.main) main()
