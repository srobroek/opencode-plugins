/**
 * Claude Code command hooks, mapped to the subset OpenCode can express:
 *
 * - `PreToolUse`  → `tool.hook("execute.before")`; exit 2 or a deny/block decision refuses the call.
 * - `PostToolUse` → `tool.hook("execute.after")`; exit 2 stderr, a block reason or
 *   `additionalContext` is appended to the tool result the model sees.
 * - `SessionStart` (source `startup`) → the `session.created` event of a top-level session;
 *   stdout or `additionalContext` becomes a synthetic message.
 *
 * Everything else (other events, `prompt`/`agent` hook types, `if` conditions) is reported
 * and never run. Parsing and interpretation are pure; {@link runHook} spawns the command.
 */

import { supervise } from "@srobroek/opencode-lib/subprocess"
import { type Diagnostic, mcpName } from "./convert.ts"

export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart"
export const HOOK_EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "SessionStart"]
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000

export type HookSpec = {
  plugin: string
  root: string
  event: HookEvent
  /** Claude matcher: a tool-name regex for tool events, a source regex for SessionStart; "" matches all. */
  matcher: string
  command: string
  timeoutMs: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The command hooks in one hooks document (`{ "hooks": { <event>: [...] } }`), and what was dropped. */
export function parseHooks(document: unknown, plugin: string, root: string, where: string): { hooks: HookSpec[]; diagnostics: Diagnostic[] } {
  const hooks: HookSpec[] = []
  const diagnostics: Diagnostic[] = []
  const events = isRecord(document) ? document.hooks : undefined
  if (!isRecord(events)) return { hooks, diagnostics: [{ where, message: "hooks must be an object" }] }
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      diagnostics.push({ where, message: `${event}: expected a list` })
      continue
    }
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      if (groups.length > 0) diagnostics.push({ where, message: `Unsupported hook event ${event}; not run` })
      continue
    }
    for (const group of groups) {
      const matcher = isRecord(group) && typeof group.matcher === "string" ? group.matcher : ""
      const entries = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []
      for (const entry of entries) {
        if (!isRecord(entry) || entry.type !== "command" || typeof entry.command !== "string") {
          diagnostics.push({ where, message: `${event}: unsupported hook type ${String(isRecord(entry) ? entry.type : entry)}; not run` })
          continue
        }
        if (entry.if !== undefined) {
          diagnostics.push({ where, message: `${event}: hook with an \`if\` condition; not run` })
          continue
        }
        if (event === "SessionStart" && !matcherMatches(matcher, ["startup"])) {
          diagnostics.push({ where, message: `SessionStart hook for ${matcher}; only startup is supported; not run` })
          continue
        }
        const seconds = typeof entry.timeout === "number" && entry.timeout > 0 ? entry.timeout : undefined
        hooks.push({
          plugin,
          root,
          event: event as HookEvent,
          matcher,
          command: entry.command,
          timeoutMs: seconds === undefined ? DEFAULT_HOOK_TIMEOUT_MS : seconds * 1000,
        })
      }
    }
  }
  return { hooks, diagnostics }
}

/** OpenCode built-in tool → the Claude names a matcher may use for it. */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  shell: ["Bash"],
  read: ["Read"],
  edit: ["Edit", "MultiEdit"],
  write: ["Write"],
  patch: ["Edit", "Write", "MultiEdit"],
  glob: ["Glob"],
  grep: ["Grep"],
  webfetch: ["WebFetch"],
  websearch: ["WebSearch"],
  subagent: ["Task", "Agent"],
  skill: ["Skill"],
  question: ["AskUserQuestion"],
}

/**
 * The Claude names of an OpenCode tool call. A direct MCP tool `<server>_<tool>` of a known
 * server also matches `mcp__<server>__<tool>` and `mcp__plugin_<plugin>_<server>__<tool>`.
 */
export function claudeToolNames(tool: string, servers: ReadonlyMap<string, string>): string[] {
  const builtin = CLAUDE_TOOL_NAMES[tool]
  if (builtin) return [...builtin]
  for (const [server, plugin] of servers)
    if (tool.startsWith(`${mcpName(server)}_`)) {
      const name = tool.slice(mcpName(server).length + 1)
      return [`mcp__${server}__${name}`, `mcp__plugin_${plugin}_${server}__${name}`]
    }
  return [tool]
}

/** Whether a Claude matcher (an anchored regex; "" or "*" for all) matches one of `names`. */
export function matcherMatches(matcher: string, names: readonly string[]): boolean {
  if (matcher === "" || matcher === "*") return true
  try {
    const pattern = new RegExp(`^(?:${matcher})$`)
    return names.some((name) => pattern.test(name))
  } catch {
    return names.includes(matcher)
  }
}

/** OpenCode tool input in Claude's field names, keeping the original fields. */
export function claudeToolInput(tool: string, input: unknown): Record<string, unknown> {
  const value = isRecord(input) ? { ...input } : {}
  const rename: Record<string, string> = { oldString: "old_string", newString: "new_string", replaceAll: "replace_all", include: "glob" }
  if (typeof value.path === "string" && ["read", "edit", "write", "patch"].includes(tool)) value.file_path = value.path
  for (const [from, to] of Object.entries(rename)) if (value[from] !== undefined && value[to] === undefined) value[to] = value[from]
  return value
}

export type HookRun =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string }
  | { kind: "failed"; reason: string }

export type HookOutcome =
  | { effect: "none"; warning?: string }
  | { effect: "block"; reason: string }
  | { effect: "ask"; reason: string }
  | { effect: "context"; text: string }

function json(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim()
  if (!text.startsWith("{")) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/** What one hook run means for its event, following Claude's exit-code and JSON-output contract. */
export function interpretHook(event: HookEvent, run: HookRun): HookOutcome {
  if (run.kind === "failed") return { effect: "none", warning: run.reason }
  const stderr = run.stderr.trim()
  if (run.exitCode === 2) {
    if (event === "PreToolUse") return { effect: "block", reason: stderr || "blocked by hook" }
    if (event === "PostToolUse") return stderr ? { effect: "context", text: stderr } : { effect: "none" }
    return { effect: "none", warning: `SessionStart hook exited 2: ${stderr}` }
  }
  if (run.exitCode !== 0) return { effect: "none", warning: `hook exited ${run.exitCode}${stderr ? `: ${stderr}` : ""}` }
  const output = json(run.stdout)
  const specific = isRecord(output?.hookSpecificOutput) ? output.hookSpecificOutput : {}
  const context = text(specific.additionalContext)
  if (output?.continue === false) {
    const reason = text(output.stopReason) ?? "stopped by hook"
    return event === "PreToolUse" ? { effect: "block", reason } : { effect: "context", text: reason }
  }
  if (event === "PreToolUse") {
    const decision = specific.permissionDecision ?? (output?.decision === "block" ? "deny" : undefined)
    const reason = text(specific.permissionDecisionReason) ?? text(output?.reason) ?? "blocked by hook"
    if (decision === "deny") return { effect: "block", reason }
    if (decision === "ask") return { effect: "ask", reason }
    // Plain stdout goes to Claude's transcript, not the model; "allow" cannot bypass OpenCode permissions.
    return { effect: "none" }
  }
  if (event === "PostToolUse") {
    const parts = [output?.decision === "block" ? text(output.reason) : undefined, context].filter(Boolean)
    return parts.length > 0 ? { effect: "context", text: parts.join("\n") } : { effect: "none" }
  }
  const body = context ?? (output === undefined ? text(run.stdout) : undefined)
  return body ? { effect: "context", text: body } : { effect: "none" }
}

/** Environment names a hook always gets from the host; anything else needs the `env` option. */
export const HOOK_ENV: readonly string[] = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "TERM"]

/** The host environment reduced to {@link HOOK_ENV}, `LC_*` and the `extra` names. */
export function hookEnvironment(env: Record<string, string | undefined>, extra: readonly string[] = []): Record<string, string> {
  const allowed = new Set([...HOOK_ENV, ...extra])
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && (allowed.has(name) || name.startsWith("LC_"))) out[name] = value
  return out
}

/**
 * Run a hook command with `sh -c` in its own process group, with Claude's JSON payload on
 * stdin and a deadline. A timeout or `signal` kills the whole group. Never throws.
 */
export async function runHook(
  spec: HookSpec,
  payload: unknown,
  env: Record<string, string>,
  cwd: string,
  signal?: AbortSignal,
): Promise<HookRun> {
  if (signal?.aborted) return { kind: "failed", reason: "hook aborted before start" }
  try {
    const child = Bun.spawn(["/bin/sh", "-c", spec.command], {
      cwd,
      env: { ...env, CLAUDE_PLUGIN_ROOT: spec.root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const done = supervise(child, { timeoutMs: spec.timeoutMs, group: true, ...(signal ? { signal } : {}) })
    try {
      child.stdin.write(JSON.stringify(payload))
      await child.stdin.end()
    } catch {
      // A hook that exits without reading stdin closes the pipe; its result still counts.
    }
    const run = await done
    if (run.kind !== "exited") return { kind: "failed", reason: `hook ${run.kind}: ${spec.command}` }
    return { kind: "exited", exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }
  } catch (error) {
    return { kind: "failed", reason: `hook could not start: ${String(error)}` }
  }
}
