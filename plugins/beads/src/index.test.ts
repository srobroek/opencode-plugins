import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { setBdShowRunForTests } from "./bd-close-gate.ts"
import plugin, { type AdapterDeps, pinnedEnvironment, setupBeads, shellPin } from "./index.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(withStore = false): string {
  // realpath: macOS hands out /var/folders/..., a symlink to /private/var/folders/...
  const root = mkdtempSync(join(realpathSync(tmpdir()), "beads-adapter-"))
  roots.push(root)
  if (withStore) mkdirSync(join(root, ".beads"))
  return root
}

const sessions = [
  { id: "ses_root" },
  { id: "ses_lead", parentID: "ses_root" },
  { id: "ses_child", parentID: "ses_lead" },
]

const quietEnv = { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv

async function start(directory: string, deps: AdapterDeps = {}, options: Record<string, unknown> = {}) {
  const fake = createFakeContext({ directory, sessions, options })
  const cleanup = await setupBeads(fake.context, { env: quietEnv, pinFor: () => undefined, ...deps })
  return { fake, cleanup }
}

type Before = { tool: string; sessionID: string; agent: string; messageID: string; id: string; input: unknown }

function shellCall(command: string, sessionID = "ses_root", id = "call_1"): Before {
  return { tool: "shell", sessionID, agent: "general", messageID: "msg_1", id, input: { command } }
}

describe("plugin definition", () => {
  test("has the srobroek.beads id and disposes every registration", async () => {
    expect(plugin.id).toBe("srobroek.beads")
    const { fake, cleanup } = await start(scratch())
    expect(fake.hooks("tool")).toEqual(["execute.before", "execute.after"])
    expect(fake.hooks("shell")).toEqual(["create.before"])
    expect(fake.hooks("session")).toEqual(["context", "compaction", "generate", "prompt", "experimental.idle"])
    await cleanup()
    expect(fake.active()).toBe(0)
  })
})

describe("execute.before on shell", () => {
  test("refuses `bd update --status closed` by throwing the gate reason", async () => {
    const { fake, cleanup } = await start(scratch())
    await expect(fake.fire.tool("execute.before", shellCall("bd update proj-1 --status closed"))).rejects.toThrow(
      /bd close ID --reason.*gates\.bd-update-close-gate\.enabled=false/s,
    )
    await cleanup()
  })

  test("refuses `bd edit`", async () => {
    const { fake, cleanup } = await start(scratch())
    await expect(fake.fire.tool("execute.before", shellCall("bd edit proj-1"))).rejects.toThrow(/\$EDITOR/)
    await cleanup()
  })

  test("gates a bash alias call like shell", async () => {
    const { fake, cleanup } = await start(scratch())
    const bash = { ...shellCall("bd edit proj-1"), tool: "bash", input: { cmd: ["bd", "edit", "proj-1"] } }
    await expect(fake.fire.tool("execute.before", bash)).rejects.toThrow(/\$EDITOR/)
    await cleanup()
  })

  test("a switched-off gate lets the command through", async () => {
    const { fake, cleanup } = await start(scratch(), {}, { gates: { "bd-update-close-gate": { enabled: false } } })
    const event = await fake.fire.tool("execute.before", shellCall("bd update proj-1 --status closed"))
    expect((event.input as { command: string }).command).toEndWith("; bd update proj-1 --status closed")
    await cleanup()
  })

  test("prefixes the subagent actor, scoped by root session, agent and session", async () => {
    const { fake, cleanup } = await start(scratch())
    const event = await fake.fire.tool("execute.before", shellCall("bd list --json", "ses_child"))
    expect((event.input as { command: string }).command).toBe(
      "export BEADS_ACTOR='opencode/ses_root/general/ses_child'; bd list --json",
    )
    await cleanup()
  })

  test("prefixes a main session's bd call, and leaves a non-bd command and a chosen actor alone", async () => {
    const { fake, cleanup } = await start(scratch())
    const main = await fake.fire.tool("execute.before", shellCall("bd list"))
    expect((main.input as { command: string }).command).toBe("export BEADS_ACTOR='opencode/general/ses_root'; bd list")
    const chosen = await fake.fire.tool("execute.before", shellCall("BEADS_ACTOR=me bd create --title t"))
    expect((chosen.input as { command: string }).command).toBe("BEADS_ACTOR=me bd create --title t")
    const other = await fake.fire.tool("execute.before", shellCall("git status", "ses_child"))
    expect((other.input as { command: string }).command).toBe("git status")
    await cleanup()
  })

  test("a subagent keeps an actor the command chose, through either variable", async () => {
    const { fake, cleanup } = await start(scratch())
    for (const command of [
      "BD_ACTOR=me bd create --title t",
      "export BD_ACTOR=me; bd create --title t",
      "BEADS_ACTOR=me bd create --title t",
      "export BEADS_ACTOR=me; bd create --title t",
    ]) {
      const event = await fake.fire.tool("execute.before", shellCall(command, "ses_child"))
      expect((event.input as { command: string }).command).toBe(command)
    }
    await cleanup()
  })

  test("prefixes a bd write that sits inside a command substitution", async () => {
    const { fake, cleanup } = await start(scratch())
    const event = await fake.fire.tool("execute.before", shellCall("id=$(bd create --title t --json)", "ses_child"))
    expect((event.input as { command: string }).command).toBe(
      "export BEADS_ACTOR='opencode/ses_root/general/ses_child'; id=$(bd create --title t --json)",
    )
    await cleanup()
  })

  test("a main session defers to an ambient actor", async () => {
    const env = { ...quietEnv, BEADS_ACTOR: "ambient/me" } as NodeJS.ProcessEnv
    const { fake, cleanup } = await start(scratch(), { env })
    const event = await fake.fire.tool("execute.before", shellCall("bd list"))
    expect((event.input as { command: string }).command).toBe("bd list")
    await cleanup()
  })

  test("lets a main session and a subagent claim under their own actors instead of refusing", async () => {
    const { fake, cleanup } = await start(scratch())
    const main = await fake.fire.tool("execute.before", shellCall("bd update proj-1 --claim"))
    expect((main.input as { command: string }).command).toStartWith("export BEADS_ACTOR='opencode/general/ses_root'")
    const event = await fake.fire.tool("execute.before", shellCall("bd update proj-1 --claim", "ses_child"))
    expect((event.input as { command: string }).command).toStartWith("export BEADS_ACTOR=")
    await cleanup()
  })

  test("ignores other tools", async () => {
    const { fake, cleanup } = await start(scratch())
    const event = await fake.fire.tool("execute.before", { ...shellCall(""), tool: "read", input: { path: "x" } })
    expect(event.input).toEqual({ path: "x" })
    await cleanup()
  })
})

describe("gate admission scope", () => {
  // A bd read that never settles stands in for a 20 s ledger verification.
  const slow = () => new Promise<never>(() => {})

  test("a subagent spawn passes at once while verification is pending", async () => {
    const { fake, cleanup } = await start(scratch(true), { run: slow })
    const started = Date.now()
    await fake.fire.tool("execute.before", { ...shellCall(""), tool: "subagent", input: { prompt: "go" } })
    expect(Date.now() - started).toBeLessThan(1000)
    await cleanup()
  })

  test("a plain shell command passes at once while verification is pending", async () => {
    const { fake, cleanup } = await start(scratch(true), { run: slow })
    const started = Date.now()
    await fake.fire.tool("execute.before", shellCall("ls -la"))
    expect(Date.now() - started).toBeLessThan(1000)
    await cleanup()
  })

  test("a bd write still refuses while the store's gates cannot be verified", async () => {
    const { fake, cleanup } = await start(scratch(true), { run: async () => ({ failure: "bd exploded" }) })
    await expect(fake.fire.tool("execute.before", shellCall("bd create --title test"))).rejects.toThrow(
      /could not be verified.*bd exploded/s,
    )
    await cleanup()
  })
})

describe("shell create.before", () => {
  test("project store overrides server env and reaches prime and shell children", async () => {
    const root = scratch()
    const store = join(root, "ledger")
    mkdirSync(store)
    writeFileSync(join(store, "metadata.json"), "{}")
    const seen: string[] = []
    const { fake, cleanup } = await start(root, {
      env: { BEADS_DIR: "/server/.beads" },
      run: async (_cwd, _args, _deadline, env) => {
        seen.push(env?.BEADS_DIR ?? "")
        return { output: "null" }
      },
    }, { store: "ledger" })
    const event = await fake.fire.shell("create.before", {
      command: "bd list", cwd: root, timeout: 0, shell: "/bin/zsh", env: { BEADS_DIR: "/server/.beads" },
    })
    expect(event.env.BEADS_DIR).toBe(store)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => value === store)).toBe(true)
    await cleanup()
  })

  test.each(["metadata.json", "embeddeddolt"])("two project roots share a canonical runner store with %s and a literal prefix overrides it", async (marker) => {
    const ledger = scratch()
    if (marker === "metadata.json") writeFileSync(join(ledger, marker), "{}")
    else mkdirSync(join(ledger, marker))
    const roots = [scratch(), scratch()]
    for (const root of roots) {
      symlinkSync(ledger, join(root, "ledger"))
      const { fake, cleanup } = await start(root, {
        runnerLookup: () => ({ interpreter: "/opt/bun", script: "/opt/runner.ts" }),
      }, { store: "ledger", gates: { "beads-gate-admission": false } })
      const event = await fake.fire.tool("execute.before", shellCall("bd create --title test", "ses_child"))
      expect((event.input as { command: string }).command).toContain(`--beads-store '${ledger}'`)
      const other = scratch()
      writeFileSync(join(other, "metadata.json"), "{}")
      const explicit = await fake.fire.tool("execute.before", shellCall(`BEADS_DIR=${other} bd create --title test`, "ses_child"))
      expect((explicit.input as { command: string }).command).toContain(`--beads-store '${other}'`)
      await cleanup()
    }
  })

  test("an invalid project store keeps refusing writes without any internal bd command", async () => {
    let calls = 0
    const { fake, cleanup } = await start(scratch(), { run: async () => { calls++; return { output: "null" } } }, { store: "missing" })
    await expect(fake.fire.tool("execute.before", shellCall("bd create --title test"))).rejects.toThrow(/Invalid beads store option/)
    await expect(fake.fire.shell("create.before", {
      command: "bd list", cwd: "/x", timeout: 0, shell: "/bin/zsh", env: {},
    })).rejects.toThrow(/Invalid beads store option/)
    expect(calls).toBe(0)
    await cleanup()
  })

  test("pins BEADS_DIR and clears the shared-server switch in the child env", async () => {
    const { fake, cleanup } = await start(scratch(), { pinFor: () => "/repo/.beads" })
    const event = await fake.fire.shell("create.before", {
      command: "bd list",
      cwd: "sub",
      timeout: 0,
      shell: "/bin/zsh",
      env: { BEADS_DOLT_SHARED_SERVER: "1" } as Record<string, string | undefined>,
    })
    expect(event.env.BEADS_DIR).toBe("/repo/.beads")
    expect(event.env.BEADS_DOLT_SHARED_SERVER).toBe("")
    await cleanup()
  })

  test("honours an explicitly set BEADS_DIR", async () => {
    const { fake, cleanup } = await start(scratch(), { pinFor: () => "/repo/.beads" })
    const event = await fake.fire.shell("create.before", {
      command: "bd list",
      cwd: "/x",
      timeout: 0,
      shell: "/bin/zsh",
      env: { BEADS_DIR: "/mine/.beads" } as Record<string, string | undefined>,
    })
    expect(event.env.BEADS_DIR).toBe("/mine/.beads")
    expect(event.env.BEADS_DOLT_SHARED_SERVER).toBeUndefined()
    await cleanup()
  })

  test("shellPin and pinnedEnvironment agree", () => {
    expect(shellPin("/x", {}, () => "/p")).toBe("/p")
    expect(shellPin("/x", { BEADS_DIR: "/q" }, () => "/p")).toBeUndefined()
    expect(pinnedEnvironment("/x", {}, () => "/p")).toEqual({ BEADS_DIR: "/p", BEADS_DOLT_SHARED_SERVER: "" })
    expect(pinnedEnvironment("/x", {}, () => undefined)).toEqual({})
  })
})

describe("execute.after on shell", () => {
  beforeAll(() =>
    setBdShowRunForTests((argv) => ({
      exitCode: 0,
      stdout: JSON.stringify(
        argv.filter((word) => /^proj-/.test(word)).map((id) => ({ id, issue_type: "task" })),
      ),
    })),
  )
  afterAll(() => setBdShowRunForTests(null))

  function completed(before: Before, output: string, exit = 0) {
    return {
      tool: "shell",
      sessionID: before.sessionID,
      agent: before.agent,
      messageID: before.messageID,
      id: before.id,
      input: before.input,
      status: "completed" as const,
      result: { content: output, output: { exit, output }, metadata: { exit } },
    }
  }

  const GENERATED = "opencode/ses_root/general/ses_child"

  /**
   * A stand-in `bd` on PATH that prints what bd 1.3.1 prints for a claim: `✓ Updated issue: X — title`
   * as text, a JSON array of the leased issue with `--json`, and on a lost claim `issue already claimed
   * by <actor>` (JSON: an `error`/`failed` object) with exit 1. It logs `BEADS_DIR` and argv per call.
   */
  const FAKE_BD = `#!/bin/sh
ledger=\${BEADS_DIR:-}; json=0; actor=\${BD_ACTOR:-\${BEADS_ACTOR:-}}; id=""; verb=""
echo "BEADS_DIR=\${BEADS_DIR:-} $*" >> "$FAKE_BD_LOG"
for arg in "$@"; do :; done
while [ $# -gt 0 ]; do
  case $1 in
    --json) json=1 ;;
    --actor) shift; actor=$1 ;;
    --actor=*) actor=\${1#--actor=} ;;
    -C|--directory) shift; ledger=$1/.beads ;;
    --directory=*) ledger=\${1#--directory=}/.beads ;;
    --db|--database) shift; ledger=$1 ;;
    --db=*) ledger=\${1#--db=} ;;
    --database=*) ledger=\${1#--database=} ;;
    --dolt-auto-commit|--notes|--assignee) [ $# -gt 1 ] && shift ;;
    -*) ;;
    update|claim|ready) [ -z "$verb" ] && verb=$1 ;;
    *) [ -z "$id" ] && [ -n "$verb" ] && id=$1 ;;
  esac
  shift
done
[ -z "$id" ] && id=proj-ready
echo "LEDGER=$ledger $id" >> "$FAKE_BD_LOG"
if [ -n "\${FAKE_BD_LOST:-}" ]; then
  if [ $json = 1 ]; then
    printf '{"error":"1 of 1 issues failed to update","failed":[{"id":"%s","error":"updating issue: issue already claimed by %s"}],"schema_version":1}\\n' "$id" "$FAKE_BD_LOST"
  else
    echo "issue already claimed by $FAKE_BD_LOST" >&2
  fi
  exit 1
fi
if [ $json = 1 ] && [ -z "\${FAKE_BD_IGNORES_JSON:-}" ]; then
  printf '[{"id":"%s","status":"in_progress","assignee":"%s","lease_expires_at":"2026-11-17T10:05:00Z","heartbeat_at":"2026-11-17T10:00:00Z"}]\\n' "$id" "$actor"
else
  printf '✓ Updated issue: %s — Title\\n' "$id"
fi
`
  let fixtureBin = ""
  beforeAll(() => {
    fixtureBin = mkdtempSync(join(realpathSync(tmpdir()), "beads-fake-bd-"))
    writeFileSync(join(fixtureBin, "bd"), FAKE_BD, { mode: 0o755 })
  })
  afterAll(() => rmSync(fixtureBin, { recursive: true, force: true }))

  type ClaimOptions = { lost?: string; ignoresJson?: boolean; env?: Record<string, string>; inherited?: Record<string, string>; childBeadsDir?: string }

  /**
   * Run `commands` in order as one session would: the plugin rewrites each in `execute.before`, the
   * rewritten command executes against the stand-in `bd` in a real shell, and its real output and
   * exit status go to `execute.after`. Returns the claims stored and the last result and command.
   */
  async function claimThrough(
    input: string[] | ((where: { root: string; store: string }) => string[]),
    options: ClaimOptions = {},
    session = "ses_child",
  ) {
    const root = scratch(true)
    const store = join(root, ".beads")
    const commands = typeof input === "function" ? input({ root, store }) : input
    const log = join(root, "bd.log")
    writeFileSync(log, "")
    // Gate admission and release talk to bd through `run`; only the agent's own command reaches the stand-in.
    const { fake, cleanup } = await start(root, {
      // The plugin pins the session's ledger itself; the process environment sets no ledger.
      env: { ...quietEnv, PATH: `${fixtureBin}:${process.env.PATH}`, ...options.inherited },
      pinFor: () => store,
      run: async () => ({ output: "null" }),
    })
    let rewritten = ""
    let result = ""
    for (const [index, command] of commands.entries()) {
      const before = shellCall(command, session, `call_${index}`)
      const event = await fake.fire.tool("execute.before", before)
      rewritten = (event.input as { command: string }).command
      const child = Bun.spawn(["sh", "-c", rewritten], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: `${fixtureBin}:${process.env.PATH}`,
          HOME: process.env.HOME,
          BEADS_DIR: options.childBeadsDir ?? store,
          FAKE_BD_LOG: log,
          ...options.env,
          ...(options.lost === undefined ? {} : { FAKE_BD_LOST: options.lost }),
          ...(options.ignoresJson === true ? { FAKE_BD_IGNORES_JSON: "1" } : {}),
        },
      })
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      const after = await fake.fire.tool("execute.after", completed(before, out + err, exit))
      result = String(after.result.content)
    }
    const state = fake.storage.get(`claims/${session}`) as
      | { claims: Record<string, { id: string; actor: string; store: string | null }> }
      | undefined
    return {
      claims: Object.values(state?.claims ?? {}),
      recorded: Object.fromEntries(Object.values(state?.claims ?? {}).map((claim) => [claim.id, claim.actor])),
      result,
      rewritten,
      store,
      root,
      leases: Object.keys((fake.storage.get(`leases/${session}`) as object | undefined) ?? {}),
      log: readFileSync(log, "utf8"),
      cleanup,
    }
  }

  test("tracks a plain claim under the actor bd reports, and adds --json to get that report", async () => {
    const run = await claimThrough(["bd update proj-1 --claim"])
    expect(run.rewritten).toBe(`export BEADS_ACTOR='${GENERATED}'; bd update --json proj-1 --claim`)
    expect(run.recorded).toEqual({ "proj-1": GENERATED })
    expect(run.claims[0]?.store).toBe(run.store)
    expect(run.log).toContain(`BEADS_DIR=${run.store} update --json proj-1 --claim`)
    expect(run.result).toContain('"status":"in_progress"')
    expect(run.result).toContain("added --json to this claim")
    await run.cleanup()
  })

  test("tracks a claim whose own --json is already there, without saying it added one", async () => {
    const run = await claimThrough(["BD_ACTOR=me/chosen bd update proj-1 --claim --json"])
    expect(run.recorded).toEqual({ "proj-1": "me/chosen" })
    expect(run.result).not.toContain("added --json")
    await run.cleanup()
  })

  test("a semicolon, && or pipe inside a quoted --notes is not a command list: the claim is tracked", async () => {
    const run = await claimThrough(['bd update proj-1 --claim --notes "step 1; step 2 && done | ok"'])
    expect(run.rewritten).toEndWith(`bd update --json proj-1 --claim --notes "step 1; step 2 && done | ok"`)
    expect(run.recorded).toEqual({ "proj-1": GENERATED })
    await run.cleanup()
  })

  test.each([
    ["-C", "update proj-1 --claim --json -C OTHER"],
    ["--directory", "update proj-1 --claim --json --directory OTHER"],
    ["--directory=", "update proj-1 --claim --json --directory=OTHER"],
    ["--db", "update proj-1 --claim --json --db OTHER/.beads"],
    ["--dolt-auto-commit", "update proj-1 --claim --json --dolt-auto-commit off"],
  ])("a post-verb %s selector leaves the claim untracked, with a warning", async (_flag, tail) => {
    const command = `bd ${tail.replace("OTHER", scratch(true))}`
    const run = await claimThrough([command])
    expect(run.recorded).toEqual({})
    expect(run.log).toContain("update proj-1 --claim --json")
    expect(run.result).toContain("this claim is not tracked")
    expect(run.result).toContain("ledger selector")
    await run.cleanup()
  })

  test.each([
    ["a list", "bd update proj-1 --claim; echo done"],
    ["an and-list", "true && bd update proj-1 --claim"],
    ["an or-list", "bd update proj-1 --claim || true"],
    ["a pipe", "bd update proj-1 --claim --json | cat"],
    ["a background job", "bd update proj-1 --claim &"],
    ["a subshell", "(bd update proj-1 --claim)"],
    ["a command substitution", "x=$(bd update proj-1 --claim --json); echo $x"],
  ])("%s leaves the claim untracked, with a warning", async (_name, command) => {
    const run = await claimThrough([command])
    expect(run.recorded).toEqual({})
    expect(run.log).toContain("proj-1")
    expect(run.result).toContain("this claim is not tracked")
    expect(run.result).toContain("not a single plain `bd` command")
    await run.cleanup()
  })

  test.each([
    ["-C", (other: string) => `-C ${other}`],
    ["--directory", (other: string) => `--directory ${other}`],
    ["--directory=", (other: string) => `--directory=${other}`],
    ["--db", (other: string) => `--db ${other}/.beads`],
    ["--db=", (other: string) => `--db=${other}/.beads`],
    ["--database=", (other: string) => `--database=${other}/.beads`],
  ])("a pre-verb %s to another ledger tracks nothing, though the ambient ledger shows the same bead and holder", async (_flag, selector) => {
    // The ambient ledger is the session's own (BEADS_DIR); the claim is aimed at a second one.
    const other = scratch(true)
    const run = await claimThrough([`bd ${selector(other)} update proj-1 --claim`])
    expect(run.log).toContain(`LEDGER=${join(other, ".beads")} proj-1`)
    expect(run.log).not.toContain(`LEDGER=${run.store} `)
    expect(run.claims).toEqual([])
    expect(run.leases).toEqual([])
    expect(run.result).toContain("this claim is not tracked")
    await run.cleanup()
  })

  test.each<[string, (ambient: { root: string; store: string }, other: string) => string]>([
    ["--db twice", ({ store }, other) => `--db ${store} --db ${join(other, ".beads")}`],
    ["--db= twice", ({ store }, other) => `--db=${store} --db=${join(other, ".beads")}`],
    ["-C twice", ({ root }, other) => `-C ${root} -C ${other}`],
    ["--directory twice", ({ root }, other) => `--directory ${root} --directory ${other}`],
    ["-C then --directory", ({ root }, other) => `-C ${root} --directory ${other}`],
    ["--db then --database", ({ store }, other) => `--db ${store} --database ${join(other, ".beads")}`],
    ["--db then -C", ({ store }, other) => `--db ${store} -C ${other}`],
  ])("repeated or mixed selectors (%s) whose last value is another ledger track nothing", async (_name, selectors) => {
    const other = scratch(true)
    const run = await claimThrough((ambient) => [`bd ${selectors(ambient, other)} update proj-1 --claim`])
    // bd took the last value: the stand-in received the other ledger, not the ambient one.
    expect(run.log).toContain(`LEDGER=${join(other, ".beads")} proj-1`)
    expect(run.claims).toEqual([])
    expect(run.leases).toEqual([])
    expect(run.result).toContain("ledger selector")
    await run.cleanup()
  })

  test.each([
    ["BEADS_DB=x", "BEADS_DB"],
    ["BD_DB=x", "BD_DB"],
    ["BEADS_DIR=x", "BEADS_DIR"],
  ])("a %s assignment on the command leaves the claim untracked", async (assignment) => {
    const run = await claimThrough([`${assignment} bd update proj-1 --claim`])
    expect(run.claims).toEqual([])
    expect(run.leases).toEqual([])
    expect(run.result).toContain("this claim is not tracked")
    await run.cleanup()
  })

  test.each(["BEADS_DB", "BD_DB", "BD_SOCKET", "BEADS_DOLT_SERVER_PORT"])("%s in the plugin's own environment is its ledger: a plain claim is tracked with a lease", async (name) => {
    const run = await claimThrough(["bd update proj-1 --claim"], { inherited: { [name]: "/private/ledger/path" } })
    expect(run.recorded).toEqual({ "proj-1": GENERATED })
    expect(run.leases).toHaveLength(1)
    expect(run.result).not.toContain("not tracked")
    await run.cleanup()
  })

  test("an inline BEADS_DIR other than the plugin's own is refused with a warning", async () => {
    const own = join(scratch(true), ".beads")
    const other = join(scratch(true), ".beads")
    const run = await claimThrough([`BEADS_DIR=${other} bd update proj-1 --claim`], { inherited: { BEADS_DIR: own }, env: { BEADS_DIR: own } })
    expect(run.recorded).toEqual({})
    expect(run.result).toContain("this claim is not tracked")
    await run.cleanup()
  })

  test("an inline BEADS_DIR equal to the plugin's own is tracked", async () => {
    const own = join(scratch(true), ".beads")
    const run = await claimThrough([`BEADS_DIR=${own}/ bd update proj-1 --claim`], { inherited: { BEADS_DIR: own }, env: { BEADS_DIR: own } })
    expect(run.recorded).toEqual({ "proj-1": GENERATED })
    expect(run.leases).toHaveLength(1)
    await run.cleanup()
  })

  test("a runner-wrapped claim the agent types is not tracked and warns", async () => {
    const run = await claimThrough(({ root }) => {
      const runner = join(root, "bd-embedded-write-runner.js")
      writeFileSync(runner, 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"\n')
      return [`sh ${runner} --beads-store ${root} -- bd update proj-1 --claim`]
    })
    expect(run.recorded).toEqual({})
    expect(run.leases).toEqual([])
    expect(run.result).toContain("this claim is not tracked")
    expect(run.result).toContain("embedded-write runner")
    await run.cleanup()
  })

  test("an inherited BEADS_DIR is the default ledger: a plain claim is tracked under that store", async () => {
    const inherited = scratch(true)
    const store = join(inherited, ".beads")
    const run = await claimThrough(["bd update proj-1 --claim"], { inherited: { BEADS_DIR: store }, childBeadsDir: store })
    expect(run.log).toContain(`LEDGER=${store} proj-1`)
    expect(run.claims).toEqual([{ id: "proj-1", actor: GENERATED, store }])
    await run.cleanup()
  })

  test("a session whose ledger the plugin pinned still tracks a plain claim", async () => {
    const run = await claimThrough(["bd update proj-1 --claim"])
    expect(run.log).toContain(`LEDGER=${run.store} proj-1`)
    expect(run.claims).toEqual([{ id: "proj-1", actor: GENERATED, store: run.store }])
    await run.cleanup()
  })

  test("a selector the shell computes after the verb leaves the claim untracked and reaches the other ledger", async () => {
    const other = scratch(true)
    const run = await claimThrough(["bd update proj-1 --claim $SEL"], { env: { SEL: `--db ${join(other, ".beads")}` } })
    expect(run.log).toContain(`LEDGER=${join(other, ".beads")} proj-1`)
    expect(run.claims).toEqual([])
    expect(run.result).toContain("computed by the shell")
    await run.cleanup()
  })

  test("a nonempty --assignee that names a known session actor ends tracking and renewal", async () => {
    const claimed = await claimThrough(["bd update proj-1 --claim"])
    expect(claimed.claims).toHaveLength(1)
    expect(claimed.leases).toHaveLength(1)
    await claimed.cleanup()
    const run = await claimThrough(["bd update proj-1 --claim", `bd update proj-1 --assignee ${GENERATED}`])
    expect(run.claims).toEqual([])
    expect(run.leases).toEqual([])
    await run.cleanup()
  })

  test("a bd that ignores --json (text only) leaves the claim untracked, with a warning", async () => {
    const run = await claimThrough(["bd update proj-1 --claim"], { ignoresJson: true })
    expect(run.result).toContain("✓ Updated issue: proj-1 — Title")
    expect(run.recorded).toEqual({})
    expect(run.result).toContain("bd printed no --json output")
    await run.cleanup()
  })

  test.each([
    ["--assignee", "bd update proj-1 --claim --assignee"],
    ["--notes", "bd update proj-1 --claim --notes"],
  ])("a trailing value option (%s) never swallows the added --json: bd's argv is otherwise identical", async (_name, command) => {
    const run = await claimThrough([command])
    const argv = (run.log.split("\n")[0] ?? "").replace(`BEADS_DIR=${run.store} `, "")
    expect(argv).toBe(command.replace("bd ", "").replace("update ", "update --json "))
    expect(argv.replace(" --json", "")).toBe(command.replace("bd ", ""))
    expect(argv).not.toMatch(/--(assignee|notes) --json/)
    await run.cleanup()
  })

  test("a failed claim says it is not tracked, naming the exit status", async () => {
    const run = await claimThrough(["bd update proj-1 --claim"], { lost: "someone/else" })
    expect(run.result).toContain("this claim is not tracked")
    expect(run.result).toContain("the claim failed (exit 1)")
    await run.cleanup()
  })

  test("a failed command that claims nothing gets no tracking warning", async () => {
    const run = await claimThrough(["bd update proj-1 --status blocked"], { lost: "someone/else" })
    expect(run.result).not.toContain("not tracked")
    await run.cleanup()
  })

  test("a lost claim (exit 1) records nothing", async () => {
    const run = await claimThrough(["bd update proj-1 --claim"], { lost: "someone/else" })
    expect(run.result).toContain("issue already claimed by someone/else")
    expect(run.recorded).toEqual({})
    await run.cleanup()
  })

  test("an --actor flag names the holder bd must report; a computed one leaves the claim untracked", async () => {
    const run = await claimThrough(["bd update proj-1 --claim --actor me/flag --json"])
    expect(run.recorded).toEqual({ "proj-1": "me/flag" })
    await run.cleanup()
    const other = await claimThrough(['bd update proj-1 --claim --actor "$WHO" --json'])
    expect(other.recorded).toEqual({})
    expect(other.result).toContain("computed by the shell")
    await other.cleanup()
  })

  test("repeated claims of one bead under different actors keep the latest holder bd confirmed", async () => {
    const run = await claimThrough(["BD_ACTOR=actor/a bd update proj-1 --claim", "BD_ACTOR=actor/b bd update proj-1 --claim"])
    expect(run.claims).toHaveLength(1)
    expect(run.recorded).toEqual({ "proj-1": "actor/b" })
    await run.cleanup()
  })

  test("two claims of one bead under different actors in one command are tracked under neither", async () => {
    const run = await claimThrough(["BD_ACTOR=actor/a bd update proj-1 --claim; BD_ACTOR=actor/b bd update proj-1 --claim"])
    expect(run.recorded).toEqual({})
    expect(run.result).toContain("this claim is not tracked")
    await run.cleanup()
  })

  test.each([
    'if [ -n "$CUSTOM_ACTOR" ]; then export BD_ACTOR=alice; fi; bd create --title t',
    'if [ -n "$CUSTOM_ACTOR" ]; then export BEADS_ACTOR=alice; fi; bd create --title t',
    '[ -n "$CUSTOM_ACTOR" ] && export BD_ACTOR=alice; bd create --title t',
    '[ -n "$CUSTOM_ACTOR" ] || export BEADS_ACTOR=alice; bd create --title t',
    'for i in 1; do export BD_ACTOR=alice; done; bd create --title t',
  ])("a conditional actor export is injected around with BD_ACTOR, which it still overrides: %s", async (command) => {
    const { fake, cleanup } = await start(scratch())
    const event = await fake.fire.tool("execute.before", shellCall(command, "ses_child"))
    expect((event.input as { command: string }).command).toStartWith(
      "export BD_ACTOR='opencode/ses_root/general/ses_child'; ",
    )
    await cleanup()
  })

  test("an unconditional export still counts as naming the actor", async () => {
    const { fake, cleanup } = await start(scratch())
    const command = "export BD_ACTOR=alice && bd create --title t"
    const event = await fake.fire.tool("execute.before", shellCall(command, "ses_child"))
    expect((event.input as { command: string }).command).toBe(command)
    await cleanup()
  })

  test.each([
    "( export BEADS_ACTOR=x; true ); bd create --title t",
    "id=$(export BEADS_ACTOR=x; true); bd create --title t",
    "{ true; }; ( export BD_ACTOR=x ); bd create --title t",
  ])("an actor exported inside a subshell does not suppress injection for the outer command: %s", async (command) => {
    const { fake, cleanup } = await start(scratch())
    const event = await fake.fire.tool("execute.before", shellCall(command, "ses_child"))
    expect((event.input as { command: string }).command).toStartWith(
      "export BEADS_ACTOR='opencode/ses_root/general/ses_child'; ",
    )
    await cleanup()
  })

  test("injects BD_ACTOR when the only named actors use BD_ACTOR, so their choice still wins", async () => {
    const { fake, cleanup } = await start(scratch())
    const event = await fake.fire.tool(
      "execute.before",
      shellCall("BD_ACTOR=A bd update a-1 --claim; bd update a-2 --claim", "ses_child"),
    )
    expect((event.input as { command: string }).command).toStartWith("export BD_ACTOR='opencode/ses_root/general/ses_child'; ")
    await cleanup()
  })

  test("drops a claim the same session later closes", async () => {
    const run = await claimThrough(["bd update proj-1 --claim", 'bd close proj-1 --reason "done"'])
    expect(run.claims).toEqual([])
    await run.cleanup()
  })

  test("appends the contention advisory to a contended result", async () => {
    const { fake, cleanup } = await start(scratch())
    const before = shellCall("bd list", "ses_root")
    await fake.fire.tool("execute.before", before)
    const event = await fake.fire.tool(
      "execute.after",
      completed(before, "Error: other bd commands are using this workspace: wait for them to finish and retry", 1),
    )
    expect(String(event.result.content)).toContain("embedded-store contention")
    await cleanup()
  })

  test("appends the actor advisory for a write that names a dynamic actor", async () => {
    const { fake, cleanup } = await start(scratch())
    const before = shellCall('BEADS_ACTOR="$WHO" bd close proj-1 --reason done')
    await fake.fire.tool("execute.before", before)
    const event = await fake.fire.tool("execute.after", completed(before, "✓ Closed proj-1"))
    expect(String(event.result.content)).toContain("BEADS_ACTOR and BD_ACTOR are unset")
    await cleanup()
  })
})

describe("bd prime context", () => {
  test("injects the same prime text on every request and reads it once", async () => {
    const root = scratch(true)
    const calls: string[][] = []
    const { fake, cleanup } = await start(root, {
      run: async (_cwd, args) => {
        calls.push(args)
        return { output: args[0] === "prime" ? "# Beads Workflow Context\n" : "null" }
      },
    })
    const request = () => ({ sessionID: "ses_root", agent: "general", system: [] as unknown[] })
    const one = await fake.fire.session("context", request())
    const two = await fake.fire.session("context", request())
    expect(one.system).toEqual([{ type: "text", text: "# Beads Workflow Context" }])
    expect(two.system).toEqual(one.system)
    // Compaction keeps the turns' system prompt, so it reuses their prompt cache.
    expect((await fake.fire.session("compaction", request())).system).toEqual(one.system)
    expect(calls.filter((args) => args[0] === "prime")).toHaveLength(1)
    expect(fake.storage.get("prime/ses_root")).toEqual({ text: "# Beads Workflow Context" })
    await cleanup()
  })

  test("injects nothing outside a beads checkout", async () => {
    const { fake, cleanup } = await start(scratch())
    const event = await fake.fire.session("context", { sessionID: "ses_root", agent: "general", system: [] })
    expect(event.system).toEqual([])
    await cleanup()
  })
})
