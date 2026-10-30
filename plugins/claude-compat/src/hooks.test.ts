// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures exercise literal Claude placeholders.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeToolInput, claudeToolNames, type HookSpec, hookEnvironment, interpretHook, matcherMatches, parseHooks, runHook } from "./hooks.ts"

const ROOT = join(import.meta.dir, "..", "fixtures", "marketplace", "plugins", "demo")
const fixture = () => parseHooks(JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")), "demo", ROOT, "hooks.json")

describe("parseHooks", () => {
  test("keeps command hooks of supported events and reports the rest", () => {
    const { hooks, diagnostics } = fixture()
    expect(hooks.map((hook) => [hook.event, hook.matcher, hook.timeoutMs])).toEqual([
      ["PreToolUse", "Bash", 10_000],
      ["PostToolUse", "Read", 60_000],
      ["SessionStart", "startup", 60_000],
    ])
    expect(diagnostics.map((issue) => issue.message)).toEqual([
      "PreToolUse: unsupported hook type agent; not run",
      "Unsupported hook event UserPromptSubmit; not run",
    ])
  })

  test("P2b: SessionStart hooks that cannot match startup are reported, not kept", () => {
    const parsed = parseHooks(
      { hooks: { SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: "a" }] }, { matcher: "startup|clear", hooks: [{ type: "command", command: "b" }] }] } },
      "p",
      "/r",
      "w",
    )
    expect(parsed.hooks.map((hook) => hook.command)).toEqual(["b"])
    expect(parsed.diagnostics).toEqual([{ where: "w", message: "SessionStart hook for resume; only startup is supported; not run" }])
  })

  test("drops hooks with an `if` condition and reports a malformed document", () => {
    const parsed = parseHooks({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x", if: "Write(a/*)" }] }] } }, "p", "/r", "w")
    expect(parsed.hooks).toEqual([])
    expect(parsed.diagnostics[0]?.message).toContain("`if` condition")
    expect(parseHooks([], "p", "/r", "w").diagnostics).toEqual([{ where: "w", message: "hooks must be an object" }])
  })
})

describe("matching", () => {
  const servers = new Map([["aws-sfdc-mcp", "pace"]])
  test("OpenCode tools match their Claude names; MCP tools match both Claude spellings", () => {
    expect(claudeToolNames("shell", servers)).toEqual(["Bash"])
    expect(claudeToolNames("patch", servers)).toEqual(["Edit", "Write", "MultiEdit"])
    expect(claudeToolNames("aws-sfdc-mcp_search_accounts", servers)).toEqual([
      "mcp__aws-sfdc-mcp__search_accounts",
      "mcp__plugin_pace_aws-sfdc-mcp__search_accounts",
    ])
    expect(matcherMatches("Write|Edit", claudeToolNames("write", servers))).toBe(true)
    expect(matcherMatches("Write|Edit", claudeToolNames("read", servers))).toBe(false)
    expect(matcherMatches("Bash", ["Bashful"])).toBe(false)
    expect(matcherMatches("", ["anything"])).toBe(true)
    expect(matcherMatches("mcp__aws-sfdc-mcp__search_accounts", claudeToolNames("aws-sfdc-mcp_search_accounts", servers))).toBe(true)
    expect(matcherMatches("(", ["("])).toBe(true)
    expect(claudeToolNames("awslabs_echo_shout", new Map([["awslabs.echo", "demo"]]))).toEqual([
      "mcp__awslabs.echo__shout", "mcp__plugin_demo_awslabs.echo__shout",
    ])
  })

  test("tool input gains Claude field names", () => {
    expect(claudeToolInput("edit", { path: "/a", oldString: "x", newString: "y" })).toEqual({
      path: "/a",
      file_path: "/a",
      oldString: "x",
      newString: "y",
      old_string: "x",
      new_string: "y",
    })
    expect(claudeToolInput("shell", { command: "ls" })).toEqual({ command: "ls" })
  })
})

describe("interpretHook", () => {
  const exited = (exitCode: number, stdout = "", stderr = "") => ({ kind: "exited" as const, exitCode, stdout, stderr })
  test("PreToolUse: exit 2 and deny/block decisions block; ask asks; plain stdout and allow do nothing", () => {
    expect(interpretHook("PreToolUse", exited(2, "", "nope\n"))).toEqual({ effect: "block", reason: "nope" })
    expect(interpretHook("PreToolUse", exited(0, '{"decision":"block","reason":"old"}'))).toEqual({ effect: "block", reason: "old" })
    const deny = '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"new"}}'
    expect(interpretHook("PreToolUse", exited(0, deny))).toEqual({ effect: "block", reason: "new" })
    expect(interpretHook("PreToolUse", exited(0, '{"hookSpecificOutput":{"permissionDecision":"ask"}}')).effect).toBe("ask")
    expect(interpretHook("PreToolUse", exited(0, '{"continue":false,"stopReason":"halt"}'))).toEqual({ effect: "block", reason: "halt" })
    expect(interpretHook("PreToolUse", exited(0, "SFDC SAFETY: reminder"))).toEqual({ effect: "none" })
    expect(interpretHook("PreToolUse", exited(0, '{"hookSpecificOutput":{"permissionDecision":"allow"}}'))).toEqual({ effect: "none" })
  })

  test("non-blocking failures warn and never block", () => {
    expect(interpretHook("PreToolUse", exited(1, "", "boom"))).toEqual({ effect: "none", warning: "hook exited 1: boom" })
    expect(interpretHook("PreToolUse", { kind: "failed", reason: "hook timeout: x" })).toEqual({ effect: "none", warning: "hook timeout: x" })
  })

  test("PostToolUse and SessionStart produce context", () => {
    expect(interpretHook("PostToolUse", exited(2, "", "fix it"))).toEqual({ effect: "context", text: "fix it" })
    expect(interpretHook("PostToolUse", exited(0, '{"decision":"block","reason":"r","hookSpecificOutput":{"additionalContext":"c"}}'))).toEqual({ effect: "context", text: "r\nc" })
    expect(interpretHook("PostToolUse", exited(0, "plain"))).toEqual({ effect: "none" })
    expect(interpretHook("SessionStart", exited(0, "hello\n"))).toEqual({ effect: "context", text: "hello" })
    expect(interpretHook("SessionStart", exited(0, '{"hookSpecificOutput":{"additionalContext":"ctx"}}'))).toEqual({ effect: "context", text: "ctx" })
  })
})

describe("runHook", () => {
  const spec = (command: string, timeoutMs = 10_000): HookSpec => ({ plugin: "demo", root: ROOT, event: "PreToolUse", matcher: "", command, timeoutMs })
  test("passes the JSON payload on stdin and CLAUDE_PLUGIN_ROOT in the environment", async () => {
    const guard = spec('sh "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"')
    const blocked = await runHook(guard, { tool_input: { command: "echo forbidden-fixture-word" } }, hookEnvironment(process.env), ROOT)
    expect(blocked).toMatchObject({ kind: "exited", exitCode: 2 })
    expect(interpretHook("PreToolUse", blocked)).toEqual({ effect: "block", reason: "fixture guard: forbidden-fixture-word is not allowed" })
    expect(await runHook(guard, { tool_input: { command: "ls" } }, hookEnvironment(process.env), ROOT)).toMatchObject({ kind: "exited", exitCode: 0 })
    const env = await runHook(spec('printf %s "$CLAUDE_PLUGIN_ROOT:$CLAUDE_PROJECT_DIR"'), {}, { ...hookEnvironment(process.env), CLAUDE_PROJECT_DIR: "/p" }, ROOT)
    expect(env).toMatchObject({ stdout: `${ROOT}:/p` })
  })

  test("a hook past its deadline is killed and reported, not blocking", async () => {
    const run = await runHook(spec("sleep 5", 200), {}, hookEnvironment(process.env), ROOT)
    expect(run).toEqual({ kind: "failed", reason: "hook timeout: sleep 5" })
  })

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const grandchild = async (signal: AbortSignal | undefined, timeoutMs: number) => {
    const base = join(tmpdir(), "opencode")
    mkdirSync(base, { recursive: true })
    const dir = mkdtempSync(join(base, "claude-compat-hook-"))
    try {
      const pidfile = join(dir, "pid")
      const env = { ...hookEnvironment(process.env), PIDFILE: pidfile }
      const run = await runHook(spec('sleep 30 & echo $! > "$PIDFILE"; wait', timeoutMs), {}, env, dir, signal)
      const pid = Number(readFileSync(pidfile, "utf8").trim())
      await Bun.sleep(100)
      return { run, pid }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("P1c: a timeout kills the hook's whole process group, not just the shell", async () => {
    const { run, pid } = await grandchild(undefined, 300)
    expect(run.kind).toBe("failed")
    expect(alive(pid)).toBe(false)
  })

  test("P1c: an abort kills the group too, and an aborted signal never starts a hook", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const { run, pid } = await grandchild(controller.signal, 30_000)
    expect(run).toEqual({ kind: "failed", reason: 'hook aborted: sleep 30 & echo $! > "$PIDFILE"; wait' })
    expect(alive(pid)).toBe(false)
    expect(await runHook(spec("echo x"), {}, {}, ROOT, controller.signal)).toEqual({ kind: "failed", reason: "hook aborted before start" })
  })
})

describe("hookEnvironment", () => {
  test("S1: keeps the allowlist, LC_* and extra names only", () => {
    const env = { PATH: "/bin", HOME: "/h", LC_ALL: "C", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "y", EXTRA: "z", UNSET: undefined }
    expect(hookEnvironment(env)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C" })
    expect(hookEnvironment(env, ["EXTRA", "UNSET"])).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", EXTRA: "z" })
  })
})
