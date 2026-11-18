import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const HOOK = join(import.meta.dir, "claude-hook.ts")

let root = ""
let repo = ""
let bin = ""
let cacheDir = ""
beforeAll(() => {
  root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-hook-process-"))
  repo = join(root, "repo")
  bin = join(root, "bin")
  cacheDir = join(root, "verdicts")
  mkdirSync(join(repo, ".beads"), { recursive: true })
  mkdirSync(bin)
  // A bd that answers `prime` and takes FAKE_BD_DELAY seconds to list gates.
  writeFileSync(
    join(bin, "bd"),
    '#!/bin/sh\ncase "$1" in\n  prime) printf "PRIME CONTEXT" ;;\n  gate) sleep "${FAKE_BD_DELAY:-0}"; printf \'{"data":[],"schema_version":1}\' ;;\n  *) printf "{}" ;;\nesac\n',
  )
  chmodSync(join(bin, "bd"), 0o755)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Run = { code: number; stdout: string; stderr: string }

async function hook(sub: string | undefined, stdin: string, env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", HOOK, ...(sub === undefined ? [] : [sub])], {
    cwd: repo,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      BEADS_GATE_VERDICT_DIR: cacheDir,
      ...env,
    },
  })
  const [stdout, stderr, code] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited]
  return { code, stdout, stderr }
}

const bash = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command }, tool_use_id: "t1", ...extra })

describe("beads claude-hook executable: pre-tool-use", () => {
  test("denies a gate refusal on stdout and exits 0", async () => {
    const run = await hook("pre-tool-use", bash("bd edit proj-1"))
    expect(run.code).toBe(0)
    const output = JSON.parse(run.stdout).hookSpecificOutput
    expect(output).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" })
    expect(output.permissionDecisionReason).toEndWith("(beads gate bd-editor-gate)")
  })

  test("rewrites a subagent's bd command with its actor", async () => {
    const run = await hook("pre-tool-use", bash("bd show proj-1", { agent_id: "a1", agent_type: "explore" }))
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).hookSpecificOutput.updatedInput.command).toBe("export BEADS_ACTOR='claude/s1/explore/a1'; bd show proj-1")
  })

  test("says nothing about a command no gate looks at", async () => {
    expect(await hook("pre-tool-use", bash("ls -la"))).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  test.each([
    ["input that is not JSON", "pre-tool-use", "not json"],
    ["empty input", "pre-tool-use", ""],
    ["an unknown subcommand", "frobnicate", "{}"],
    ["no subcommand", undefined, "{}"],
  ])("a failure on %s exits 0 with no decision", async (_, sub, stdin) => {
    const run = await hook(sub, stdin)
    expect(run.code).toBe(0)
    expect(run.stdout).toBe("")
  })

  test("a malformed input is reported on stderr only", async () => {
    expect((await hook("pre-tool-use", "not json")).stderr).toContain("srobroek beads hook:")
  })
})

describe("beads claude-hook executable: slow gate verification", () => {
  test("the retry of a mutation whose gate read outlasted the wait is admitted from the stored verdict", async () => {
    // Its own verdict directory: other tests leave a fresh verified verdict for the same store.
    const env = { FAKE_BD_DELAY: "2", BEADS_CLAUDE_HOOK_BUDGET_MS: "400", BEADS_GATE_VERDICT_DIR: join(root, "slow-verdicts") }
    const first = await hook("pre-tool-use", bash('bd create "x"'), env)
    expect(first.code).toBe(0)
    const denied = JSON.parse(first.stdout).hookSpecificOutput
    expect(denied.permissionDecision).toBe("deny")
    expect(denied.permissionDecisionReason).toContain("still being verified")

    // The detached verify process stores its verdict when bd answers.
    let admitted: Run | undefined
    for (let attempt = 0; attempt < 40; attempt++) {
      await Bun.sleep(250)
      const retry = await hook("pre-tool-use", bash('bd create "x"'), env)
      if (retry.stdout === "" || JSON.parse(retry.stdout).hookSpecificOutput.permissionDecision !== "deny") {
        admitted = retry
        break
      }
    }
    expect(admitted?.code).toBe(0)
    expect(admitted).toBeDefined()
  }, 30_000)
})

describe("beads claude-hook executable: session-start", () => {
  test("prints bd prime as context and appends the store pin to CLAUDE_ENV_FILE", async () => {
    const envFile = join(root, "claude-env")
    const run = await hook("session-start", JSON.stringify({ session_id: "s1", cwd: repo, hook_event_name: "SessionStart" }), {
      CLAUDE_ENV_FILE: envFile,
    })
    expect(run.code).toBe(0)
    const output = JSON.parse(run.stdout).hookSpecificOutput
    expect(output.hookEventName).toBe("SessionStart")
    expect(output.additionalContext).toContain("PRIME CONTEXT")
    expect(existsSync(envFile)).toBe(true)
    expect(readFileSync(envFile, "utf8")).toContain(`export BEADS_DIR='`)
  })

  test("without CLAUDE_ENV_FILE it still prints the context and exits 0", async () => {
    const run = await hook("session-start", JSON.stringify({ session_id: "s1", cwd: repo }))
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain("PRIME CONTEXT")
  })

  test("a failure exits 0 with no output", async () => {
    expect(await hook("session-start", "{")).toMatchObject({ code: 0, stdout: "" })
  })
})
