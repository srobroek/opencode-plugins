import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { processAlive } from "@srobroek/opencode-lib/subprocess"

/** The runner's store flags, as the gate writes them: the real path held, the path as named. */
const runnerStore = (store: string): string[] => ["--beads-store", realpathSync(store), "--beads-store-selected", store]


const HOOK = join(import.meta.dir, "claude-hook.ts")

/**
 * Each test starts Bun or Node subprocesses. Measured: a hook test runs in about 0.2 s alone and
 * passed the 5 s default under a full `bun run check`.
 */
const SPAWN_MS = 30_000

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
  writeExecutable(
    join(bin, "bd"),
    '#!/bin/sh\ncase "$1" in\n  prime) printf "PRIME CONTEXT" ;;\n  gate) sleep "${FAKE_BD_DELAY:-0}"; printf \'{"data":[],"schema_version":1}\' ;;\n  *) printf "{}" ;;\nesac\n',
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Run = { code: number; stdout: string; stderr: string }

async function hook(
  sub: string | undefined,
  stdin: string,
  env: Record<string, string> = {},
  where: { cwd: string; bin: string } = { cwd: repo, bin },
): Promise<Run> {
  const proc = Bun.spawn(["bun", HOOK, ...(sub === undefined ? [] : [sub])], {
    cwd: where.cwd,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${where.bin}:${process.env.PATH}`,
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
  }, SPAWN_MS)

  test("rewrites a subagent's bd command with its actor", async () => {
    const run = await hook("pre-tool-use", bash("bd show proj-1", { agent_id: "a1", agent_type: "explore" }))
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).hookSpecificOutput.updatedInput.command).toBe("unset BEADS_ACTOR; export BD_ACTOR='claude/s1/explore/a1'; bd show proj-1")
  }, SPAWN_MS)

  test("says nothing about a command no gate looks at", async () => {
    expect(await hook("pre-tool-use", bash("ls -la"))).toEqual({ code: 0, stdout: "", stderr: "" })
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
  }, SPAWN_MS)

  test("a malformed input is reported on stderr only", async () => {
    expect((await hook("pre-tool-use", "not json")).stderr).toContain("srobroek beads hook:")
  }, SPAWN_MS)
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

describe("beads claude-hook executable: slow gate check on an embedded store", () => {
  type Entry = { event: string; at: number; pid: number; ppid: number; locked: boolean }

  test("the check keeps the store's write lock past the hook's exit, and a write waits for it", async () => {
    const dir = join(root, "slow-check")
    const embeddedRepo = join(dir, "repo")
    const store = join(embeddedRepo, ".beads")
    const fakeBin = join(dir, "bin")
    const log = join(dir, "bd.log")
    mkdirSync(join(store, "embeddeddolt"), { recursive: true })
    mkdirSync(fakeBin)
    // A bd with one automatic gate whose `gate check` takes FAKE_CHECK_MS. Each check and create
    // logs its start and end, and whether the store's embedded write lock exists at that moment.
    // The list answers from sh at once, so the hook's budget runs out inside the check.
    writeExecutable(
      join(fakeBin, "bd"),
      `#!/bin/sh
if [ "$1 $2" = "gate list" ]; then
  printf '%s' '{"schema_version":1,"data":[{"id":"g-1","await_type":"timer","status":"open","description":"Reason: wait"}]}'
  exit 0
fi
exec bun "$(dirname "$0")/fake-bd.ts" "$@"
`,
    )
    writeFileSync(
      join(fakeBin, "fake-bd.ts"),
      `import { appendFileSync, existsSync } from "node:fs"
const args = process.argv.slice(2).filter((arg) => arg !== "--json")
const note = (event) => appendFileSync(process.env.FAKE_BD_LOG, JSON.stringify({ event, at: Date.now(), pid: process.pid, ppid: process.ppid, locked: existsSync(process.env.FAKE_BD_STORE + "/omp-embedded-write.lock") }) + "\\n")
if (args[0] === "gate" && args[1] === "check") {
  note("check-start")
  await Bun.sleep(Number(process.env.FAKE_CHECK_MS))
  note("check-end")
  process.stdout.write(JSON.stringify({ schema_version: 1, data: { resolved: 0, escalated: 0, errors: 0 } }))
} else if (args[0] === "create") {
  note("create-start")
  await Bun.sleep(50)
  note("create-end")
} else process.stdout.write("{}")
`,
    )
    const env = {
      FAKE_CHECK_MS: "4000",
      FAKE_BD_LOG: log,
      FAKE_BD_STORE: store,
      BEADS_CLAUDE_HOOK_BUDGET_MS: "1500",
      BEADS_GATE_VERDICT_DIR: join(dir, "verdicts"),
    }
    const where = { cwd: embeddedRepo, bin: fakeBin }
    const entries = (): Entry[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Entry)
        : []
    const decision = (run: Run) => (run.stdout === "" ? undefined : JSON.parse(run.stdout).hookSpecificOutput.permissionDecision)

    const first = await hook("pre-tool-use", bash('bd create "x"', { cwd: embeddedRepo }), env, where)
    const firstExited = Date.now()
    expect(first.code).toBe(0)
    expect(decision(first)).toBe("deny")

    // A retry while the check runs is refused too, and must not start a second check.
    const second = await hook("pre-tool-use", bash('bd create "x"', { cwd: embeddedRepo }), env, where)
    expect(decision(second)).toBe("deny")

    // The user's write, as the gate's rewrite runs it, while the check still holds the store.
    for (let wait = 0; wait < 40 && !entries().some((entry) => entry.event === "check-start"); wait++) await Bun.sleep(100)
    const writer = Bun.spawn(
      ["bun", join(import.meta.dir, "bd-embedded-write-runner.ts"), ...runnerStore(store), "--beads-wait-ms", "20000", "--", "bd", "create", "x"],
      { cwd: embeddedRepo, env: { ...process.env, ...env, PATH: `${fakeBin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" },
    )
    expect(await writer.exited).toBe(0)

    let admitted = false
    for (let attempt = 0; attempt < 40 && !admitted; attempt++) {
      admitted = decision(await hook("pre-tool-use", bash('bd create "x"', { cwd: embeddedRepo }), env, where)) !== "deny"
      if (!admitted) await Bun.sleep(250)
    }
    expect(admitted).toBe(true)

    const log1 = entries()
    const checks = log1.filter((entry) => entry.event === "check-start")
    const checkEnd = log1.find((entry) => entry.event === "check-end")
    const createStart = log1.find((entry) => entry.event === "create-start")
    expect(checks).toHaveLength(1)
    expect(checkEnd).toBeDefined()
    // The check outlived the hook that was waiting on it, and held the lock from start to end.
    expect(checkEnd?.at ?? 0).toBeGreaterThan(firstExited)
    expect(checks[0]?.locked).toBe(true)
    expect(checkEnd?.locked).toBe(true)
    // Its parent, the lock's owner, stayed alive until it finished.
    expect(checkEnd?.ppid).toBe(checks[0]?.ppid ?? -1)
    // The write ran only after the check let go of the store.
    expect(createStart?.at ?? 0).toBeGreaterThanOrEqual(checkEnd?.at ?? Number.POSITIVE_INFINITY)
    // Nothing is left behind: the check's parent has exited and the lock is gone.
    for (let wait = 0; wait < 20 && processAlive(checkEnd?.ppid ?? 0); wait++) await Bun.sleep(100)
    expect(processAlive(checkEnd?.ppid ?? 0)).toBe(false)
    expect(existsSync(join(store, "omp-embedded-write.lock"))).toBe(false)
  }, 60_000)
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
  }, SPAWN_MS)

  test("without CLAUDE_ENV_FILE it still prints the context and exits 0", async () => {
    const run = await hook("session-start", JSON.stringify({ session_id: "s1", cwd: repo }))
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain("PRIME CONTEXT")
  }, SPAWN_MS)

  test("a failure exits 0 with no output", async () => {
    expect(await hook("session-start", "{")).toMatchObject({ code: 0, stdout: "" })
  }, SPAWN_MS)
})
