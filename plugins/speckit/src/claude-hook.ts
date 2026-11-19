/**
 * Claude Code hook for the speckit plugin, run by `hooks/claude-hooks.json`:
 *
 *   bun dist/claude-hook.js pre-tool-use   # PreToolUse on Edit, Write and Bash
 *
 * It applies the tasks.md guard of the OpenCode plugin: in a repository with an active
 * beads workspace, a call that writes `specs/<spec>/tasks.md` is denied. Like the OpenCode
 * guard it fails open, and any failure of the hook itself exits 0 without output.
 */

import { beadsActive } from "./beads.ts"
import { type BeadsProbe, DENY_REASON, decideToolCall } from "./tasks-guard.ts"

/** The fields of Claude Code's hook input this hook reads. */
export type HookInput = { cwd?: string; tool_name?: string; tool_input?: Record<string, unknown> }

export type PreToolUseOutput = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string }
}

/** The refusal without its OpenCode option hint; Claude Code has no plugin options to set. */
export const CLAUDE_DENY_REASON = DENY_REASON.replace(/ Disable: .*$/, "")

/** A Claude Code tool call as the guard's OpenCode tool and input, or `undefined` when the guard ignores it. */
export function guardCall(input: HookInput): { tool: string; input: Record<string, string> } | undefined {
  const value = input.tool_input ?? {}
  if (input.tool_name === "Edit" || input.tool_name === "Write")
    return typeof value.file_path === "string" ? { tool: "write", input: { path: value.file_path } } : undefined
  if (input.tool_name === "Bash")
    return typeof value.command === "string" ? { tool: "shell", input: { command: value.command } } : undefined
  return undefined
}

/** The PreToolUse answer for one call, or `undefined` to leave it to Claude Code. */
export async function claudeDecision(input: HookInput, probe: BeadsProbe = beadsActive): Promise<PreToolUseOutput | undefined> {
  const call = guardCall(input)
  if (call === undefined) return undefined
  let reason: string | undefined
  try {
    reason = await decideToolCall(call.tool, call.input, input.cwd ?? process.cwd(), probe)
  } catch {
    return undefined
  }
  if (reason === undefined) return undefined
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CLAUDE_DENY_REASON },
  }
}

async function main(argv: string[]): Promise<void> {
  try {
    if (argv[0] !== "pre-tool-use") throw new Error(`unknown subcommand ${JSON.stringify(argv[0] ?? "")}`)
    const output = await claudeDecision(JSON.parse(await Bun.stdin.text()) as HookInput)
    if (output !== undefined) await Bun.write(Bun.stdout, JSON.stringify(output))
  } catch (error) {
    console.error(`srobroek speckit hook: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (import.meta.main) await main(process.argv.slice(2)).finally(() => process.exit(0))

export default main
