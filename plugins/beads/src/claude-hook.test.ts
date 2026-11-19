import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type ClaudeDeps, CONTEXT_CAP, claudeDecision, type HookInput, sessionContext, sessionStart } from "./claude-hook.ts"
import { GateAdmitter } from "./gate-admission.ts"

let root = ""
beforeAll(() => {
  root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-claude-hook-"))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const deps = (): ClaudeDeps => ({
  env: { PATH: process.env.PATH },
  admitter: new GateAdmitter(async () => ({ output: "null" })),
  pinFor: () => undefined,
  runnerLookup: () => ({ interpreter: "/opt/bun", script: "/opt/beads/dist/bd-embedded-write-runner.js" }),
  repositoryControl: () => false,
})

const bash = (command: string, extra: Partial<HookInput> = {}): HookInput => ({
  session_id: "s1",
  cwd: root,
  tool_name: "Bash",
  tool_input: { command, description: "Run it", timeout: 120000 },
  tool_use_id: "toolu_1",
  ...extra,
})

describe("claudeDecision", () => {
  test("denies a gate refusal and names the gate", async () => {
    const output = await claudeDecision(bash("bd edit proj-1"), deps())
    expect(output?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" })
    expect(output?.hookSpecificOutput.permissionDecisionReason).toContain("`bd edit` opens $EDITOR")
    expect(output?.hookSpecificOutput.permissionDecisionReason).toEndWith("(beads gate bd-editor-gate)")
  })

  test("a subagent's bd command gets its actor, and the rest of the tool input is kept", async () => {
    const output = await claudeDecision(bash("bd show proj-1", { agent_id: "a1", agent_type: "explore" }), deps())
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: "unset BEADS_ACTOR; export BD_ACTOR='claude/s1/explore/a1'; bd show proj-1",
          description: "Run it",
          timeout: 120000,
        },
      },
    })
  })

  test("a main-session bd command runs unchanged: it has no plugin actor", async () => {
    expect(await claudeDecision(bash("bd show proj-1"), deps())).toBeUndefined()
  })

  test("a subagent's actor replaces one set in the server environment", async () => {
    const output = await claudeDecision(bash("bd show proj-1", { agent_id: "a1", agent_type: "explore" }), {
      ...deps(),
      env: { PATH: process.env.PATH, BEADS_ACTOR: "server/me" },
    })
    expect(output?.hookSpecificOutput.updatedInput?.command).toStartWith("unset BEADS_ACTOR; export BD_ACTOR='claude/s1/explore/a1'; ")
  })

  test("a subagent's command no gate looks at still starts with its actor, so a script it runs writes under it", async () => {
    const output = await claudeDecision(bash("./scripts/file-issues.sh", { agent_id: "a1", agent_type: "explore" }), deps())
    expect(output?.hookSpecificOutput.updatedInput).toEqual({
      command: "unset BEADS_ACTOR; export BD_ACTOR='claude/s1/explore/a1'; ./scripts/file-issues.sh",
      description: "Run it",
      timeout: 120000,
    })
  })

  test.each([
    ["a command without bd, git or gh", bash("ls -la && echo bdx")],
    ["another tool", { ...bash("bd create --title t"), tool_name: "Read" }],
    ["an empty command", bash("  ")],
  ])("leaves %s alone", async (_, input) => {
    expect(await claudeDecision(input, deps())).toBeUndefined()
  })
})

describe("sessionContext", () => {
  test("drops advisories from the end before cutting bd prime", () => {
    expect(sessionContext("P".repeat(20), ["A".repeat(5), "B".repeat(5)], 32)).toBe(`${"P".repeat(20)}\n\n${"A".repeat(5)}`)
  })

  test("cuts an oversized bd prime to the cap and says so", () => {
    const text = sessionContext("P".repeat(CONTEXT_CAP * 2), ["advisory"])
    expect(text).toHaveLength(CONTEXT_CAP)
    expect(text).toEndWith("run `bd prime` for the rest]")
  })
})

describe("sessionStart", () => {
  test("injects bd prime with the advisories and pins the store for later shells", async () => {
    const checkout = join(root, "checkout")
    mkdirSync(join(checkout, ".beads"), { recursive: true })
    // The pinned store is the one prime reads, so it exists.
    mkdirSync(join(root, "stores", "it's"), { recursive: true })
    const result = await sessionStart(
      { session_id: "s1", cwd: checkout },
      {
        env: { PATH: process.env.PATH },
        run: async (_cwd, args) => (args[0] === "prime" ? { output: "PRIME\n" } : { failure: "unexpected" }),
        pinFor: () => join(root, "stores", "it's"),
        start: { hooksAdvisory: () => "HOOKS", identity: () => "repo" },
      },
    )
    expect(result).toEqual({
      output: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "PRIME\n\nHOOKS" } },
      exports: [
        "export BEADS_DOLT_SHARED_SERVER=''",
        `export BEADS_DIR='${root}/stores/it'\\''s'`,
        `export SROBROEK_BEADS_PIN='${root}/stores/it'\\''s'`,
      ],
    })
  })

  test("an explicit BEADS_DIR is left alone and an empty context prints nothing", async () => {
    const result = await sessionStart(
      { cwd: join(root, "nowhere") },
      { env: { BEADS_DIR: "/elsewhere" }, pinFor: () => undefined, start: { hooksAdvisory: () => undefined } },
    )
    expect(result).toEqual({ exports: [] })
  })
})

describe("a session started from another repository's pinned shell", () => {
  // Claude Code inherits the pin a beads-pinned shell exported for repository A.
  const inherited = (store: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    BEADS_DIR: store,
    SROBROEK_BEADS_PIN: store,
  })

  /** `BEADS_DIR` as a later Bash call sees it, once Claude Code sources the exported lines. */
  function bashBeadsDir(exports: string[], env: NodeJS.ProcessEnv): string {
    const script = `${exports.join("\n")}\nprintf %s "\${BEADS_DIR-}"`
    return execFileSync("/bin/sh", ["-c", script], { env, encoding: "utf8" })
  }

  test("prime and the advisories read the session's own store", async () => {
    const a = join(root, "pinned-a", ".beads")
    const b = join(root, "pinned-b")
    mkdirSync(a, { recursive: true })
    mkdirSync(join(b, ".beads"), { recursive: true })
    const primed: (string | undefined)[] = []
    const result = await sessionStart(
      { cwd: b },
      {
        env: inherited(a),
        run: async (_cwd, args, _deadline, env) => {
          if (args[0] === "prime") primed.push(env.BEADS_DIR)
          return { output: "PRIME\n" }
        },
        pinFor: (cwd) => join(cwd, ".beads"),
        start: { hooksAdvisory: () => undefined, identity: (cwd) => cwd },
      },
    )
    expect(primed).toEqual([join(b, ".beads")])
    expect(result.output?.hookSpecificOutput.additionalContext).toBe("PRIME")
    expect(bashBeadsDir(result.exports, inherited(a))).toBe(join(b, ".beads"))
  })

  test("in a directory without a store, Bash drops the old pin as the gates do", async () => {
    const a = join(root, "pinned-only-a", ".beads")
    mkdirSync(a, { recursive: true })
    writeFileSync(join(a, "metadata.json"), "{}")
    const bare = join(root, "pinned-bare")
    mkdirSync(bare, { recursive: true })
    const start = await sessionStart(
      { cwd: bare },
      { env: inherited(a), run: async () => ({ output: "" }), pinFor: () => undefined, start: { hooksAdvisory: () => undefined } },
    )
    expect(bashBeadsDir(start.exports, inherited(a))).toBe("")
    // The gates see no store either, so the write runs as typed, not under A's lock.
    const output = await claudeDecision(bash("bd create --title t", { cwd: bare }), { ...deps(), env: inherited(a) })
    expect(output?.hookSpecificOutput.updatedInput).toBeUndefined()
  })
})
