import { describe, expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import type { RunResult } from "./git.ts"
import { createPlugin } from "./index.ts"
import { type Lane, laneKey } from "./lane.ts"

const PARENT = "ses_parent"
const CHILD = "ses_child"
const REPO = "/repo"
const WT = "/wt/lane-a"
const BASE = "b".repeat(40)
const TIP = "t".repeat(40)
const NOW = 100_000_000

type World = {
  ahead: number
  porcelain: string
  /** `merge-base --is-ancestor` exit code. */
  ancestor: number
  mergedHeads: string[]
  openBranches: string[]
  /** Session `time` by id. */
  time: Record<string, Record<string, number>>
  exists: boolean
  now: number
  age: number | undefined
}

type Fake = ReturnType<typeof createFakeContext>

const lane = (over: Partial<Lane> = {}): Lane => ({
  child: CHILD,
  parent: PARENT,
  projectID: "prj",
  directory: WT,
  branch: "lane-a",
  base: BASE,
  parentDir: REPO,
  title: "Write hello",
  state: "active",
  ...over,
})

function runner(world: World, log: string[][]) {
  return async (argv: string[]): Promise<RunResult> => {
    log.push(argv)
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
    if (argv[0] === "gh") {
      if (argv.includes("merged")) return ok(JSON.stringify(world.mergedHeads.map((headRefOid) => ({ headRefOid }))))
      return ok(JSON.stringify(world.openBranches.map((headRefName) => ({ headRefName }))))
    }
    if (argv[0] === "wt") return { code: 127, stdout: "", stderr: "not installed" }
    const cmd = argv.slice(3).join(" ")
    if (cmd.startsWith("rev-list --count")) return ok(`${world.ahead}\n`)
    if (cmd === "status --porcelain") return ok(world.porcelain)
    if (cmd.startsWith("rev-parse --verify --quiet HEAD")) return ok(`${TIP}\n`)
    if (cmd.startsWith("merge-base --is-ancestor")) return { code: world.ancestor, stdout: "", stderr: "" }
    if (cmd === "rev-parse --absolute-git-dir") return ok("/nonexistent/gitdir\n")
    if (cmd.startsWith("stash list")) return ok("")
    return ok()
  }
}

async function start(
  world: Partial<World> = {},
  options: { stored?: Lane[]; options?: Record<string, unknown>; sweepDelayMs?: number } = {},
) {
  const state: World = {
    ahead: 2,
    porcelain: "",
    ancestor: 1,
    mergedHeads: [],
    openBranches: [],
    time: {},
    exists: true,
    now: NOW,
    age: undefined,
    ...world,
  }
  const fake = createFakeContext({
    directory: REPO,
    options: { sweep: "off", ...options.options },
    sessions: [
      { id: PARENT, projectID: "prj", location: { directory: REPO }, time: { busy: 1, idle: 2 } },
      { id: CHILD, parentID: PARENT, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2 } },
    ],
  })
  for (const stored of options.stored ?? [lane()]) fake.storage.set(laneKey(stored.child), stored)
  for (const [id, time] of Object.entries(state.time)) {
    const session = fake.sessions.get(id)
    if (session) session.time = time
  }
  const worktree: Array<{ method: string; input: Record<string, unknown> }> = []
  Object.assign(fake.context, {
    location: { ...(fake.context.location as object), directory: REPO, project: { id: "prj" } },
    worktree: {
      list: async () => [{ directory: WT }],
      remove: async (input: Record<string, unknown>) => void worktree.push({ method: "remove", input }),
      refresh: async (input: Record<string, unknown>) => void worktree.push({ method: "refresh", input }),
    },
  })
  const log: string[][] = []
  const plugin = createPlugin({
    run: runner(state, log),
    lookupMs: 20,
    directoryExists: async () => state.exists,
    now: () => state.now,
    debounceMs: 1,
    age: async () => state.age,
    ...(options.sweepDelayMs === undefined ? {} : { sweepDelayMs: options.sweepDelayMs }),
  })
  const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
  return { fake, state, worktree, log, cleanup }
}

const stored = (fake: Fake, child = CHILD) => fake.storage.get(laneKey(child)) as Lane
const synthetic = (fake: Fake) =>
  fake.calls.filter((entry) => entry.method === "session.synthetic").map((entry) => entry.input as { sessionID: string; text: string })
const settle = (ms = 30) => new Promise((done) => setTimeout(done, ms))
const tool = { sessionID: PARENT, agent: "a", messageID: "m", id: "t" }

describe("lane sync on a landing", () => {
  test("a delivery_cleanup result that removed the worktree retires the lane as landed and refreshes", async () => {
    const { fake, worktree, cleanup } = await start()
    await fake.fire.tool("execute.after", {
      tool: "delivery_cleanup",
      sessionID: PARENT,
      id: "c",
      input: {},
      status: "completed",
      result: { content: "ok", metadata: { ok: true, worktree: WT } },
    } as never)
    expect(stored(fake).state).toBe("landed")
    expect(worktree).toEqual([{ method: "refresh", input: { projectID: "prj" } }])
    await cleanup()
  })

  test("a result for a worktree that is not a lane changes nothing", async () => {
    const { fake, cleanup } = await start()
    await fake.fire.tool("execute.after", {
      tool: "delivery_cleanup",
      sessionID: PARENT,
      id: "c",
      input: {},
      status: "completed",
      result: { content: "ok", metadata: { ok: true, worktree: "/wt/elsewhere" } },
    } as never)
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a landed lane no longer shows in the lane list", async () => {
    const { fake, cleanup } = await start({}, { stored: [lane({ state: "landed" })] })
    const list = fake.tools.get("subagent_worktree_merge")?.execute as (i: unknown, c: unknown) => Promise<{ content: string }>
    const result = await list({ method: "list" }, tool)
    expect(JSON.stringify(result.content)).not.toContain("lane-a")
    await cleanup()
  })

  test("delivery_land is told to hold cleanup for a lane that is still active", async () => {
    const { fake, cleanup } = await start({ time: { [CHILD]: { busy: 5, idle: 2 } } })
    const event = { tool: "delivery_land", sessionID: PARENT, agent: "a", messageID: "m", id: "c", input: { pr: 7 } }
    await fake.fire.tool("execute.before", event as never)
    expect((event.input as { cleanupHold?: unknown }).cleanupHold).toEqual([
      { directory: WT, reason: "lane lane-a still active" },
    ])
    await cleanup()
  })
})

describe("execution events", () => {
  test("a failed child with commits sends exactly one notice to its parent, even when the event repeats", async () => {
    const { fake, cleanup } = await start()
    const event = { type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } }
    fake.emit(event)
    fake.emit(event)
    await settle()
    fake.emit(event)
    await settle()
    const sent = synthetic(fake)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sessionID).toBe(PARENT)
    expect(sent[0]?.text).toBe(
      "<system-reminder>Subagent ses_child (Write hello) failed: model gone. Its lane lane-a at /wt/lane-a has 2 commits ahead, uncommitted changes: no. Resume it with subagent sessionID ses_child, merge it with subagent_worktree_merge, or discard it.</system-reminder>",
    )
    expect(stored(fake).outcome).toMatchObject({ kind: "failed", reason: "model gone" })
    await cleanup()
  })

  test("an empty lane is not removed when its child succeeds", async () => {
    const { fake, worktree, cleanup } = await start({ ahead: 0 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    fake.emit({ type: "session.idle", data: { sessionID: CHILD } })
    await settle()
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("the parent going idle removes a landed, clean lane without force, then deletes the branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.map((entry) => [entry.method, entry.input.force])).toEqual([
      ["remove", false],
      ["refresh", undefined],
    ])
    expect(stored(fake).state).toBe("landed")
    expect(log.some((argv) => argv.includes("branch") && argv.includes("-D"))).toBe(true)
    await cleanup()
  })

  test("a lane resumed a minute ago is kept even when landed", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 }, { stored: [lane({ resumedAt: NOW - 60_000 })] })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a squash-merged lane is found through a merged PR whose head equals the tip", async () => {
    const { fake, worktree, cleanup } = await start({ mergedHeads: [TIP] })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("the event loop ends on dispose", async () => {
    const { fake, cleanup } = await start()
    await cleanup()
    expect(fake.active()).toBe(0)
    fake.emit({ type: "session.execution.failed", data: { sessionID: CHILD, error: {} } })
    await settle()
    expect(synthetic(fake)).toEqual([])
  })
})

describe("idle gates", () => {
  const idle = (fake: Fake, sessionID: string, background: unknown[] = []) =>
    fake.fire.session("experimental.idle", { sessionID, background } as never)

  test("a dirty child is nudged once per dirty state", async () => {
    const { fake, state, cleanup } = await start({ porcelain: " M a.txt\n" })
    await idle(fake, CHILD)
    await idle(fake, CHILD)
    expect(synthetic(fake)).toEqual([
      { sessionID: CHILD, text: `<system-reminder>Commit your work in ${WT}, or reply why it stays uncommitted.</system-reminder>` },
    ])
    state.porcelain = " M b.txt\n"
    state.now += 20_000
    await idle(fake, CHILD)
    expect(synthetic(fake)).toHaveLength(2)
    await cleanup()
  })

  test("a lead with its child still listed as running hears nothing", async () => {
    const { fake, cleanup } = await start()
    await idle(fake, PARENT, [
      { kind: "subagent", sessionID: PARENT, childSessionID: CHILD, agent: "general", description: "d" },
    ])
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a lead with a finished, unresolved lane hears once", async () => {
    const { fake, cleanup } = await start()
    await idle(fake, PARENT)
    expect(synthetic(fake)).toHaveLength(1)
    await idle(fake, PARENT)
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })

  test("an open PR counts as resolved", async () => {
    const { fake, cleanup } = await start({ openBranches: ["lane-a"] })
    await idle(fake, PARENT)
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a registered keep stops the nudge", async () => {
    const { fake, cleanup } = await start()
    const merge = fake.tools.get("subagent_worktree_merge")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { ok: boolean } }>
    const result = await merge({ method: "keep", sessionID: CHILD, reason: "later" }, tool)
    expect(result.metadata.ok).toBe(true)
    await idle(fake, PARENT)
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a landed, clean lane is removed at the lead's idle, with no message", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    await idle(fake, PARENT)
    expect(worktree[0]).toEqual({ method: "remove", input: { projectID: "prj", directory: WT, force: false } })
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("with gates off the hook is not registered", async () => {
    const { fake, cleanup } = await start({}, { options: { gates: false } })
    expect(fake.hooks("session")).not.toContain("experimental.idle")
    await cleanup()
  })
})

describe("the sweep", () => {
  type SweepResult = { content: string; metadata: { plan: Array<{ verdict: string }> } }
  const sweep = (fake: Fake, mode: string) => {
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as
      | ((i: unknown, c: unknown) => Promise<SweepResult>)
      | undefined
    if (!execute) throw new Error("sweep tool not registered")
    return execute({ mode }, tool)
  }

  test("report mode plans and removes nothing", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    const result = await sweep(fake, "report")
    expect(worktree).toEqual([])
    expect(result.content).toContain("subagent_worktree_sweep (report)")
    await cleanup()
  })

  test("a landed, clean, old, unowned lane is pruned without force; its branch goes on the landed proof", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 })
    const result = await sweep(fake, "prune")
    expect(result.metadata.plan.map((entry) => entry.verdict)).toEqual(["prune"])
    expect(worktree).toEqual([
      { method: "remove", input: { projectID: "prj", directory: WT, force: false } },
      { method: "refresh", input: { projectID: "prj" } },
    ])
    expect(log.some((argv) => argv.includes("branch") && argv.includes("-D") && argv.includes("lane-a"))).toBe(true)
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  test("a young or dirty worktree is kept or quarantined and never removed", async () => {
    const young = await start({ ancestor: 0, age: 1000 })
    expect((await sweep(young.fake, "prune")).metadata.plan[0]?.verdict).toBe("keep")
    expect(young.worktree).toEqual([])
    await young.cleanup()
    const dirty = await start({ ancestor: 0, age: 3 * 24 * 3_600_000, porcelain: " M a.txt\n" })
    expect((await sweep(dirty.fake, "prune")).metadata.plan[0]?.verdict).toBe("quarantine")
    expect(dirty.worktree).toEqual([])
    await dirty.cleanup()
  })

  test("prune mode never forces a removal", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0 })
    await sweep(fake, "prune")
    expect(worktree.every((entry) => entry.input.force !== true)).toBe(true)
    expect(log.some((argv) => argv.includes("--force") || argv.includes("-f"))).toBe(false)
    await cleanup()
  })
})

describe("the background sweep", () => {
  test("it runs after the delay, records a plan, and is throttled to once per interval", async () => {
    const { fake, state, cleanup } = await start({ ancestor: 0 }, { options: { sweep: "report" }, sweepDelayMs: 1 })
    await settle(50)
    expect(fake.storage.get("sweep/at/prj")).toBe(NOW)
    const first = fake.storage.get("sweep/last") as { at: number; mode: string }
    expect(first.mode).toBe("report")
    state.now += 3_600_000
    fake.emit({ type: "session.created", data: { sessionID: "ses_new" } })
    await settle(50)
    expect((fake.storage.get("sweep/last") as { at: number }).at).toBe(first.at)
    state.now += 7 * 3_600_000
    fake.emit({ type: "session.created", data: { sessionID: "ses_new" } })
    await settle(50)
    expect((fake.storage.get("sweep/last") as { at: number }).at).toBe(state.now)
    await cleanup()
  })

  test("sweep off never runs it", async () => {
    const { fake, cleanup } = await start({}, { options: { sweep: "off" }, sweepDelayMs: 1 })
    fake.emit({ type: "session.created", data: { sessionID: "ses_new" } })
    await settle(50)
    expect(fake.storage.has("sweep/at/prj")).toBe(false)
    await cleanup()
  })
})
