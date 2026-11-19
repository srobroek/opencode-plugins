import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { guardDecision } from "./claude-agent-guard.ts"
import type { Guard } from "./claude-agents.ts"

const read: Guard = {
  tools: ["Read"],
  rules: [
    { resource: "*.env", effect: "ask" },
    { resource: "*.env.*", effect: "ask" },
    { resource: "*.env.example", effect: "allow" },
  ],
}
const config = { "code-reviewer": [read] }

/**
 * Each test starts Bun or Node subprocesses. Measured: a hook test runs in about 0.2 s alone and
 * passed the 5 s default under a full `bun run check`.
 */
const SPAWN_MS = 30_000
const call = (file: string, agent_type: string | null = "code-reviewer", tool_name = "Read") => ({
  tool_name,
  ...(agent_type === null ? {} : { agent_type }),
  tool_input: { file_path: file },
})

describe("guardDecision", () => {
  test.each(["/repo/.env", "/repo/.env.local", "/repo/apps/web/.env.production"])("asks before the guarded agent reads %s", (file) => {
    const out = guardDecision(call(file), config)
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask")
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain(".env")
  })

  test.each(["/repo/.env.example", "/repo/src/index.ts", "/repo/environment.md"])("leaves %s to Claude Code", (file) => {
    expect(guardDecision(call(file), config)).toBeUndefined()
  })

  test("applies to a plugin-scoped agent type", () => {
    expect(guardDecision(call("/r/.env", "agent-reviewer:code-reviewer"), config)?.hookSpecificOutput.permissionDecision).toBe("ask")
  })

  test.each([
    ["the main session", null],
    ["another agent", "coder"],
    ["an agent whose name merely ends the same", "my-code-reviewer"],
  ])("ignores %s", (_, agent) => {
    expect(guardDecision(call("/r/.env", agent), config)).toBeUndefined()
  })

  test("ignores a tool the guard does not cover", () => {
    expect(guardDecision(call("/r/.env", "code-reviewer", "Grep"), config)).toBeUndefined()
  })

  test("guards the field that names the resource of other tools", () => {
    const bash: Guard = { tools: ["Bash"], rules: [{ resource: "git push *", effect: "ask" }] }
    const input = { tool_name: "Bash", agent_type: "a", tool_input: { command: "git push origin x" } }
    expect(guardDecision(input, { a: [bash] })?.hookSpecificOutput.permissionDecision).toBe("ask")
  })
})

describe("claude-agent-guard executable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-"))
  writeFileSync(path.join(dir, "guards.json"), JSON.stringify(config))
  const run = async (stdin: string, guards = dir) => {
    const proc = Bun.spawn(["bun", path.join(import.meta.dir, "claude-agent-guard.ts")], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_AGENT_GUARDS: path.join(guards, "guards.json") },
    })
    return { code: await proc.exited, out: await new Response(proc.stdout).text() }
  }

  test("asks on stdin input for a guarded read and exits 0", async () => {
    const { code, out } = await run(JSON.stringify(call("/r/.env")))
    expect(code).toBe(0)
    expect(JSON.parse(out).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "ask" })
  }, SPAWN_MS)

  test("prints nothing for an allowed read", async () => {
    expect(await run(JSON.stringify(call("/r/a.ts")))).toEqual({ code: 0, out: "" })
  }, SPAWN_MS)

  test.each([
    ["unparsable input", "not json", dir],
    ["a missing guard file", JSON.stringify(call("/r/a.ts")), path.join(dir, "missing")],
  ])("fails closed with an ask on %s", async (_, stdin, guards) => {
    const { code, out } = await run(stdin, guards)
    expect(code).toBe(0)
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("ask")
  }, SPAWN_MS)

  test("cleanup", () => rmSync(dir, { recursive: true, force: true }))
})
