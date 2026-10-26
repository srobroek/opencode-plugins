import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { setBdShowRunForTests } from "./bd-close-gate.ts"
import plugin, { type AdapterDeps, pinnedEnvironment, setupBeads, shellPin } from "./index.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(withStore = false): string {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-adapter-"))
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
    expect(fake.hooks("session")).toEqual(["context", "prompt"])
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

  test("a switched-off gate lets the command through", async () => {
    const { fake, cleanup } = await start(scratch(), {}, { gates: { "bd-update-close-gate": { enabled: false } } })
    const event = await fake.fire.tool("execute.before", shellCall("bd update proj-1 --status closed"))
    expect((event.input as { command: string }).command).toBe("bd update proj-1 --status closed")
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

  test("leaves a main session's command and a non-bd command alone", async () => {
    const { fake, cleanup } = await start(scratch())
    const main = await fake.fire.tool("execute.before", shellCall("bd list"))
    expect((main.input as { command: string }).command).toBe("bd list")
    const other = await fake.fire.tool("execute.before", shellCall("git status", "ses_child"))
    expect((other.input as { command: string }).command).toBe("git status")
    await cleanup()
  })

  test("lets a subagent claim under its own actor instead of refusing it", async () => {
    const { fake, cleanup } = await start(scratch())
    await expect(fake.fire.tool("execute.before", shellCall("bd update proj-1 --claim"))).rejects.toThrow(/BEADS_ACTOR/)
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

describe("gate admission on subagent", () => {
  test("refuses a dispatch while the store's gates cannot be verified", async () => {
    const root = scratch(true)
    const { fake, cleanup } = await start(root, { run: async () => ({ failure: "bd exploded" }) })
    await expect(
      fake.fire.tool("execute.before", { ...shellCall(""), tool: "subagent", input: { prompt: "go" } }),
    ).rejects.toThrow(/could not be verified.*bd exploded/s)
    await cleanup()
  })

  test("admits a dispatch once the store has no open gates", async () => {
    const root = scratch(true)
    const { fake, cleanup } = await start(root, { run: async () => ({ output: "null" }) })
    await fake.fire.tool("execute.before", { ...shellCall(""), tool: "subagent", input: { prompt: "go" } })
    await cleanup()
  })
})

describe("shell create.before", () => {
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

  test("records a successful claim in storage under the session", async () => {
    const { fake, cleanup } = await start(scratch())
    const before = shellCall("bd update proj-1 --claim", "ses_child")
    await fake.fire.tool("execute.before", before)
    await fake.fire.tool("execute.after", completed(before, "✓ Claimed proj-1"))
    const state = fake.storage.get("claims/ses_child") as { claims: Record<string, { id: string; actor: string }> }
    const claims = Object.values(state.claims)
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ id: "proj-1", actor: "opencode/ses_root/general/ses_child" })
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
    const { fake, cleanup } = await start(scratch())
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
    expect(String(event.result.content)).toContain("embedded-store contention, not a failure")
    await cleanup()
  })

  test("appends the actor advisory for an unattributed write", async () => {
    const { fake, cleanup } = await start(scratch())
    const before = shellCall("bd close proj-1 --reason done")
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
