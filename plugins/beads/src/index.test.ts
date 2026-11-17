import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { setBdShowRunForTests } from "./bd-close-gate.ts"
import type { BdRun } from "./gate-admission.ts"
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

  /** A bd stand-in whose `show` reports who holds each bead, as the ledger would after the claim. */
  const holdersRun =
    (holders: Record<string, string>): BdRun =>
    async (_cwd, args) => {
      const id = args[args.indexOf("show") + 1] ?? ""
      return args.includes("show") && holders[id] !== undefined
        ? { output: JSON.stringify([{ id, assignee: holders[id] }]) }
        : { failure: "bd exited with code 1: no issues found" }
    }

  async function claimThrough(command: string, holders: Record<string, string>) {
    const { fake, cleanup } = await start(scratch(), { run: holdersRun(holders) })
    const before = shellCall(command, "ses_child")
    await fake.fire.tool("execute.before", before)
    const output = `${Object.keys(holders)
      .map((id) => `✓ Claimed ${id}`)
      .join("\n")}\n`
    const event = await fake.fire.tool("execute.after", completed(before, output))
    const state = fake.storage.get("claims/ses_child") as
      | { claims: Record<string, { id: string; actor: string }> }
      | undefined
    const recorded = Object.fromEntries(Object.values(state?.claims ?? {}).map((claim) => [claim.id, claim.actor]))
    return { recorded, result: String(event.result.content), cleanup }
  }

  test.each<[string, Record<string, string>]>([
    ["bd update proj-1 --claim", { "proj-1": GENERATED }],
    ['export BEADS_ACTOR=me/chosen; bd update proj-1 --claim --notes "source and unset"', { "proj-1": "me/chosen" }],
    ["export BD_ACTOR=me/chosen; bd update proj-1 --claim", { "proj-1": "me/chosen" }],
    ["BD_ACTOR=me/chosen bd update proj-1 --claim", { "proj-1": "me/chosen" }],
    ['c=$(bd update proj-1 --claim); export BEADS_ACTOR=B; echo "$c"', { "proj-1": GENERATED }],
    ["cat <<EOF\n$(bd update proj-1 --claim)\nEOF\nexport BEADS_ACTOR=B", { "proj-1": GENERATED }],
    ["BD_ACTOR=A bd update a-1 --claim; bd update a-2 --claim", { "a-1": "A", "a-2": GENERATED }],
    ["BEADS_ACTOR=A bd update a-1 --claim; bd update a-2 --claim", { "a-1": "A", "a-2": GENERATED }],
    ["bd update a-1 --claim; BD_ACTOR=A bd update a-2 --claim", { "a-1": GENERATED, "a-2": "A" }],
    // A conditional export either ran (bd reports it) or did not (bd reports the injected actor).
    ['if [ -n "$X" ]; then export BD_ACTOR=alice; fi; bd update proj-1 --claim', { "proj-1": "alice" }],
    ['if [ -n "$X" ]; then export BD_ACTOR=alice; fi; bd update proj-1 --claim', { "proj-1": GENERATED }],
    ['[ -n "$X" ] && export BEADS_ACTOR=alice; bd update proj-1 --claim', { "proj-1": "alice" }],
    ['[ -n "$X" ] && export BEADS_ACTOR=alice; bd update proj-1 --claim', { "proj-1": GENERATED }],
    ['[ -n "$X" ] || export BD_ACTOR=alice; bd update proj-1 --claim', { "proj-1": "alice" }],
    ["bash -c 'bd update a-1 --claim'", { "a-1": GENERATED }],
    ["BD_ACTOR=A bash -c 'bd update a-1 --claim'", { "a-1": "A" }],
  ])("records the holder bd reports for the claim: %s", async (command, holders) => {
    const { recorded, cleanup } = await claimThrough(command, holders)
    expect(recorded).toEqual(holders)
    await cleanup()
  })

  test.each([
    // The shell decides what bd sees, and bd's answer must be an actor this invocation could have used.
    ["unset BEADS_ACTOR; bd update proj-1 --claim", "human@example.com"],
    ["false && export BEADS_ACTOR=B; bd update proj-1 --claim", "human@example.com"],
    ["bd update proj-1 --claim; bd update proj-1 --assignee other", "other"],
    ["bd update proj-1 --claim && bd assign proj-1 other", "other"],
  ])("does not track a claim whose reported holder is not the claiming actor: %s", async (command, holder) => {
    const { recorded, result, cleanup } = await claimThrough(command, { "proj-1": holder })
    expect(recorded).toEqual({})
    expect(result).toContain("could not confirm that this session holds proj-1")
    await cleanup()
  })

  test("looks up and records a claim against the store an earlier export selected", async () => {
    const other = scratch(true)
    const seen: Array<{ cwd: string; beadsDir: string | undefined }> = []
    const run: BdRun = async (cwd, args, _deadline, env) => {
      seen.push({ cwd, beadsDir: env.BEADS_DIR })
      return { output: JSON.stringify([{ id: args[1], assignee: GENERATED }]) }
    }
    const { fake, cleanup } = await start(scratch(), { run })
    const before = shellCall(`export BEADS_DIR=${other}/.beads; bd update proj-1 --claim`, "ses_child")
    await fake.fire.tool("execute.before", before)
    await fake.fire.tool("execute.after", completed(before, "✓ Claimed proj-1"))
    const state = fake.storage.get("claims/ses_child") as { claims: Record<string, { store: string | null }> }
    expect(seen.at(-1)?.beadsDir).toBe(join(other, ".beads"))
    expect(Object.values(state.claims)[0]?.store).toBe(join(other, ".beads"))
    await cleanup()
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

  test("skips tracking, with a warning, when bd cannot say who holds the bead", async () => {
    const { recorded, result, cleanup } = await claimThrough("bd update proj-1 --claim", {})
    expect(recorded).toEqual({})
    expect(result).toContain("could not confirm that this session holds")
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

  test("records nothing for a failed claim", async () => {
    const { fake, cleanup } = await start(scratch())
    const before = shellCall("bd update proj-1 --claim", "ses_child")
    await fake.fire.tool("execute.before", before)
    await fake.fire.tool("execute.after", completed(before, "Error: not found", 1))
    expect(fake.storage.get("claims/ses_child")).toBeUndefined()
    await cleanup()
  })

  test("drops a claim the same session later closes", async () => {
    const { fake, cleanup } = await start(scratch(), { run: holdersRun({ "proj-1": GENERATED }) })
    const claim = shellCall("bd update proj-1 --claim", "ses_child", "call_a")
    await fake.fire.tool("execute.before", claim)
    await fake.fire.tool("execute.after", completed(claim, "✓ Claimed proj-1"))
    const close = shellCall('bd close proj-1 --reason "done"', "ses_child", "call_b")
    await fake.fire.tool("execute.before", close)
    await fake.fire.tool("execute.after", completed(close, "✓ Closed proj-1"))
    const state = fake.storage.get("claims/ses_child") as { claims: Record<string, unknown> }
    expect(Object.keys(state.claims)).toHaveLength(0)
    await cleanup()
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
