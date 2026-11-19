import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { CLAUDE_DENY_REASON } from "./claude-hook.ts"

const HOOK = join(import.meta.dir, "claude-hook.ts")

/**
 * Each test starts Bun or Node subprocesses. Measured: a hook test runs in about 0.2 s alone and
 * passed the 5 s default under a full `bun run check`.
 */
const SPAWN_MS = 30_000

let root = ""
let binActive = ""
let binInactive = ""
beforeAll(() => {
  root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "speckit-hook-process-"))
  // `bd -C <dir> where` is the probe: exit 0 is an active workspace.
  for (const [name, code] of [["active", 0], ["inactive", 1]] as const) {
    const bin = join(root, name)
    mkdirSync(bin)
    writeExecutable(join(bin, "bd"), `#!/bin/sh\nexit ${code}\n`)
  }
  binActive = join(root, "active")
  binInactive = join(root, "inactive")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function hook(sub: string | undefined, stdin: string, bin = binActive) {
  const proc = Bun.spawn(["bun", HOOK, ...(sub === undefined ? [] : [sub])], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  })
  const [stdout, stderr, code] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited]
  return { code, stdout, stderr }
}

const call = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ cwd: root, tool_name, tool_input })

describe("speckit claude-hook executable", () => {
  test.each([
    ["an Edit of tasks.md", call("Edit", { file_path: "/repo/specs/001-a/tasks.md" })],
    ["a Bash redirect into tasks.md", call("Bash", { command: "echo x > specs/001-a/tasks.md" })],
  ])("denies %s on stdout and exits 0", async (_, stdin) => {
    const run = await hook("pre-tool-use", stdin)
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CLAUDE_DENY_REASON },
    })
  }, SPAWN_MS)

  test.each([
    ["an edit of another spec file", call("Edit", { file_path: "/repo/specs/001-a/spec.md" }), binActive],
    ["tasks.md without an active beads workspace", call("Edit", { file_path: "/repo/specs/001-a/tasks.md" }), binInactive],
  ])("prints nothing for %s", async (_, stdin, bin) => {
    expect(await hook("pre-tool-use", stdin, bin)).toEqual({ code: 0, stdout: "", stderr: "" })
  }, SPAWN_MS)

  test.each([
    ["input that is not JSON", "pre-tool-use", "not json"],
    ["empty input", "pre-tool-use", ""],
    ["an unknown subcommand", "frobnicate", "{}"],
    ["no subcommand", undefined, "{}"],
  ])("a failure on %s exits 0 with no decision", async (_, sub, stdin) => {
    const run = await hook(sub, stdin)
    expect(run.code).toBe(0)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("srobroek speckit hook:")
  }, SPAWN_MS)
})
