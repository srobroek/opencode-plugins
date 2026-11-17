import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { landingFile, readClaim, removeClaim, writeLanding } from "@srobroek/opencode-lib/worktree-claims"
import type { RunResult } from "./git.ts"
import { createPlugin } from "./index.ts"
import { type Lane, laneKey } from "./lane.ts"

const PARENT = "ses_parent"
const CHILD = "ses_child"
const REPO = "/repo"
const WT = "/wt/lane-a"
const BASE = "b".repeat(40)
const TIP = "t".repeat(40)
const TIP2 = "u".repeat(40)
const NOW = 100_000_000
const COMMONS: string[] = []
afterAll(() => {
  for (const root of COMMONS) rmSync(root, { recursive: true, force: true })
})

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
  /** HEAD of the worktree, and what `refs/heads/lane-a` points at. */
  head: string
  branchOid: string
  /** The worktree is on its branch (not detached). */
  onBranch: boolean
  /** Heads `wt list` reports as integrated. */
  integratedHeads: string[]
  updateRefFails: boolean
  /** Called with every git command before it is answered. */
  onGit?: (cmd: string) => Promise<void> | void
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
    if (argv[0] === "wt") {
      const items = world.integratedHeads.map((sha) => ({ branch: "lane-a", head: { sha }, display: { state: "integrated" } }))
      return ok(JSON.stringify({ items }))
    }
    const cmd = argv.slice(3).join(" ")
    await world.onGit?.(cmd)
    if (cmd.startsWith("rev-list --count")) return ok(`${world.ahead}\n`)
    if (cmd === "status --porcelain") return ok(world.porcelain)
    if (cmd.startsWith("rev-parse --verify --quiet HEAD")) return ok(`${world.head}\n`)
    if (cmd.startsWith("rev-parse --verify --quiet refs/heads/")) return ok(`${world.branchOid}\n`)
    if (cmd === "symbolic-ref --quiet --short HEAD") return world.onBranch ? ok("lane-a\n") : { code: 1, stdout: "", stderr: "" }
    if (cmd.startsWith("update-ref -d")) return { code: world.updateRefFails ? 1 : 0, stdout: "", stderr: "" }
    if (cmd.startsWith("merge-base --is-ancestor")) return { code: world.ancestor, stdout: "", stderr: "" }
    if (cmd === "rev-parse --absolute-git-dir") return ok("/nonexistent/gitdir\n")
    if (cmd.startsWith("stash list")) return ok("")
    return ok()
  }
}

async function start(
  world: Partial<World> = {},
  options: { stored?: Lane[]; options?: Record<string, unknown>; sweepDelayMs?: number; debounceMs?: number } = {},
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
    head: TIP,
    branchOid: TIP,
    onBranch: true,
    integratedHeads: [],
    updateRefFails: false,
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
  const common = mkdtempSync(join(tmpdir(), "common-"))
  COMMONS.push(common)
  const log: string[][] = []
  const plugin = createPlugin({
    commonDir: async () => common,
    run: runner(state, log),
    lookupMs: 20,
    directoryExists: async () => state.exists,
    now: () => state.now,
    debounceMs: options.debounceMs ?? 1,
    age: async () => state.age,
    ...(options.sweepDelayMs === undefined ? {} : { sweepDelayMs: options.sweepDelayMs }),
  })
  const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
  return { fake, state, worktree, log, cleanup, common }
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
    expect(log).toContainEqual(["git", "-C", REPO, "update-ref", "-d", "refs/heads/lane-a", TIP])
    expect(log.some((argv) => argv.includes("-D"))).toBe(false)
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
    expect(log).toContainEqual(["git", "-C", REPO, "update-ref", "-d", "refs/heads/lane-a", TIP])
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

describe("the branch is deleted only for the commit the proof covered", () => {
  const idleParent = async (fake: Fake) => {
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
  }
  const refDeletes = (log: string[][]) => log.filter((argv) => argv.includes("update-ref"))

  test("a detached HEAD at the landed commit removes the worktree but keeps the branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0, onBranch: false })
    await idleParent(fake)
    expect(worktree[0]?.method).toBe("remove")
    expect(refDeletes(log)).toEqual([])
    await cleanup()
  })

  test("a branch that no longer points at the proven commit blocks the removal", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0, branchOid: TIP2 })
    await idleParent(fake)
    expect(worktree).toEqual([])
    expect(refDeletes(log)).toEqual([])
    await cleanup()
  })

  test("a ref that moves between the check and the delete is not force-deleted", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0, updateRefFails: true })
    await idleParent(fake)
    expect(worktree[0]?.method).toBe("remove")
    expect(refDeletes(log)).toEqual([["git", "-C", REPO, "update-ref", "-d", "refs/heads/lane-a", TIP]])
    expect(log.some((argv) => argv.includes("-D") || argv.includes("--force"))).toBe(false)
    await cleanup()
  })
})

describe("every removal is revalidated when it is applied", () => {
  test("a cached integrated branch with a new commit is kept", async () => {
    const { fake, state, worktree, log, cleanup } = await start({
      integratedHeads: [TIP],
      time: { [CHILD]: { busy: 5, idle: 2 } },
    })
    // The child is running: facts are collected (and the proofs cached) but nothing is removed.
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    const session = fake.sessions.get(CHILD)
    if (session) session.time = { busy: 1, idle: 2 }
    state.head = TIP2
    state.branchOid = TIP2
    state.now += 10_000
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    expect(log.filter((argv) => argv[0] === "wt")).toHaveLength(1)
    await cleanup()
  })

  test("a commit that lands after the facts were read blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd.startsWith("stash list")) state.head = TIP2
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a tree that became dirty after the facts were read blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    let reads = 0
    state.onGit = (cmd) => {
      if (cmd === "status --porcelain" && ++reads === 2) state.porcelain = " M late.txt\n"
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })
})

describe("the idle gate reads every kind of background job", () => {
  const idle = (fake: Fake, background: unknown[]) => fake.fire.session("experimental.idle", { sessionID: PARENT, background } as never)

  test("a clean landed lane whose child runs a shell is deferred", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    await idle(fake, [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 30" }])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a shell a descendant of the child runs defers it too", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: WT } })
    await idle(fake, [{ kind: "shell", sessionID: "ses_grand", shellID: "sh", command: "sleep 30" }])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a shell whose command works in the lane directory defers it", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    await idle(fake, [{ kind: "shell", sessionID: PARENT, shellID: "sh", command: `cd ${WT} && make` }])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("an unknown child status defers it", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    const session = fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
    const original = session.get.bind(session)
    session.get = (input) => (input.sessionID === CHILD ? Promise.reject(new Error("lookup failed")) : original(input))
    await idle(fake, [])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("with no job and a finished child it is removed", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.sessions.set("ses_unrelated", { id: "ses_unrelated", projectID: "prj", location: { directory: REPO } })
    await idle(fake, [{ kind: "shell", sessionID: "ses_unrelated", shellID: "sh", command: "ls" }])
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("a resume fences a removal", () => {
  test("a resume while the facts are being collected cancels the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    let resumed = false
    state.onGit = async (cmd) => {
      if (cmd === "status --porcelain" && !resumed) {
        resumed = true
        await fake.fire.tool("execute.before", {
          tool: "subagent",
          sessionID: PARENT,
          agent: "build",
          messageID: "m",
          id: "call",
          input: { agent: "general", prompt: "follow up", sessionID: CHILD },
        } as never)
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(resumed).toBe(true)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("without a resume the same pass removes it", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("the sweep fails closed on ownership", () => {
  const sweepWith = async (list: (query: Record<string, unknown>) => Promise<unknown>) => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 })
    ;(fake.context.session as unknown as { list: unknown }).list = list
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { plan: Array<{ verdict: string; reason: string }> } }>
    const result = await execute({ mode: "prune" }, tool)
    await cleanup()
    return { plan: result.metadata.plan, worktree }
  }

  test("a lookup error keeps the worktree", async () => {
    const { plan, worktree } = await sweepWith(async () => {
      throw new Error("boom")
    })
    expect(plan[0]).toMatchObject({ verdict: "keep", reason: "owner unknown" })
    expect(worktree).toEqual([])
  })

  test("an owner on the second page keeps the worktree", async () => {
    const { plan, worktree } = await sweepWith(async (query) =>
      query.cursor === undefined
        ? { data: [{ id: "old", time: { busy: 1, idle: 2 } }], cursor: { next: "p2" } }
        : { data: [{ id: "live", time: { busy: 9, idle: 2 } }] },
    )
    expect(plan[0]).toMatchObject({ verdict: "keep", reason: "a live session owns it" })
    expect(worktree).toEqual([])
  })

  test("with every page read and no owner it is pruned", async () => {
    const { plan } = await sweepWith(async (query) =>
      query.cursor === undefined
        ? { data: [{ id: "old", time: { busy: 1, idle: 2 } }], cursor: { next: "p2" } }
        : { data: [{ id: "older", time: { busy: 1, idle: 2 } }] },
    )
    expect(plan[0]?.verdict).toBe("prune")
  })
})

describe("without the experimental.idle hook", () => {
  const withoutHook = async () => {
    const fake = createFakeContext({
      directory: REPO,
      options: { sweep: "off" },
      sessions: [
        { id: PARENT, projectID: "prj", location: { directory: REPO }, time: { busy: 1, idle: 2 } },
        { id: CHILD, parentID: PARENT, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2 } },
      ],
    })
    fake.storage.set(laneKey(CHILD), lane())
    const session = fake.context.session as unknown as { hook: (name: string, callback: unknown) => Promise<unknown> }
    const original = session.hook.bind(session)
    session.hook = (name, callback) => (name === "experimental.idle" ? Promise.reject(new Error("unknown hook")) : original(name, callback))
    const state: World = {
      ahead: 2, porcelain: " M a.txt\n", ancestor: 1, mergedHeads: [], openBranches: [], time: {}, exists: true, now: NOW, age: undefined,
      head: TIP, branchOid: TIP, onBranch: true, integratedHeads: [], updateRefFails: false,
    }
    Object.assign(fake.context, {
      location: { ...(fake.context.location as object), directory: REPO, project: { id: "prj" } },
      worktree: { list: async () => [], remove: async () => {}, refresh: async () => {} },
    })
    const plugin = createPlugin({ commonDir: async () => mkdtempSync(join(tmpdir(), "common-")), run: runner(state, []), lookupMs: 20, directoryExists: async () => true, now: () => state.now, debounceMs: 1 })
    const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
    return { fake, cleanup }
  }

  test("setup succeeds and the child is still nudged from the succeeded event", async () => {
    const { fake, cleanup } = await withoutHook()
    expect(fake.hooks("session")).not.toContain("experimental.idle")
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    expect(synthetic(fake)).toEqual([
      { sessionID: CHILD, text: `<system-reminder>Commit your work in ${WT}, or reply why it stays uncommitted.</system-reminder>` },
    ])
    await cleanup()
  })

  test("with the hook registered the succeeded event leaves the nudge to the gate", async () => {
    const { fake, cleanup } = await start({ porcelain: " M a.txt\n" })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })
})

describe("a notice follows the event's identity, not its time", () => {
  const failed = (id: string) => ({ id, type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } })

  test("the same failure replayed later sends no second notice", async () => {
    const { fake, state, cleanup } = await start()
    fake.emit(failed("ev1"))
    await settle()
    state.now += 3_600_000
    fake.emit(failed("ev1"))
    await settle()
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })

  test("a replay without an event id is still the same failure", async () => {
    const { fake, state, cleanup } = await start()
    const bare = { type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } }
    fake.emit(bare)
    await settle()
    state.now += 3_600_000
    fake.emit(bare)
    await settle()
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })

  test("a new failure has a new identity and is announced", async () => {
    const { fake, state, cleanup } = await start()
    fake.emit(failed("ev1"))
    await settle()
    state.now += 3_600_000
    fake.emit(failed("ev2"))
    await settle()
    expect(synthetic(fake)).toHaveLength(2)
    await cleanup()
  })
})

describe("one remover per worktree: the lane remover reads delivery's records from disk", () => {
  const landing = (over: Record<string, unknown> = {}) => ({
    receiptId: "r1",
    worktree: WT,
    headRefOid: TIP,
    sessionID: PARENT,
    landedAt: 1,
    ...over,
  })
  const denied = { denied: { at: 5, sessionID: PARENT } }
  const idleEvent = async (fake: Fake) => {
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
  }

  test("a lane is claimed on disk as soon as the lifecycle sees it, and a lost claim is restored", async () => {
    const { fake, common, cleanup } = await start({ porcelain: " M a.txt\n" })
    await idleEvent(fake)
    expect(readClaim(common, WT)).toMatchObject({ kind: "present", value: { directory: WT, sessionID: CHILD, parentID: PARENT } })
    removeClaim(common, WT)
    await idleEvent(fake)
    expect(readClaim(common, WT).kind).toBe("present")
    await cleanup()
  })

  test("a recorded denial blocks removal through the event pass", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeLanding(common, landing(denied))
    await idleEvent(fake)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a recorded denial blocks removal through the idle gate", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeLanding(common, landing(denied))
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a recorded denial blocks the sweep, which quarantines the worktree instead", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 })
    writeLanding(common, landing(denied))
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { plan: Array<{ verdict: string }> } }>
    const result = await execute({ mode: "prune" }, tool)
    expect(result.metadata.plan[0]?.verdict).toBe("quarantine")
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("once the denial is cleared on disk the same lane is removed", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeLanding(common, landing(denied))
    await idleEvent(fake)
    expect(worktree).toEqual([])
    writeLanding(common, landing())
    await idleEvent(fake)
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("a landing record that cannot be read blocks removal: no records is not the same as unreadable ones", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    mkdirSync(join(common, "opencode", "landings"), { recursive: true })
    writeFileSync(landingFile(common, "9-bad"), "garbage")
    await idleEvent(fake)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("the head delivery recorded as landed is a landed proof while it is still the tip", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 1 })
    writeLanding(common, landing())
    await idleEvent(fake)
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("a recorded head that is no longer the tip proves nothing", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 1 })
    writeLanding(common, landing({ headRefOid: TIP2 }))
    await idleEvent(fake)
    expect(worktree).toEqual([])
    await cleanup()
  })
})

describe("liveness is read when the removal is applied", () => {
  test("a new parent turn that starts before the debounce fires blocks the removal", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 }, { debounceMs: 40 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle(5)
    const parent = fake.sessions.get(PARENT)
    if (parent) parent.time = { busy: 9, idle: 2 }
    await settle(120)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a parent turn that starts while the facts are collected blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    let reads = 0
    state.onGit = (cmd) => {
      if (cmd === "status --porcelain" && ++reads === 1) {
        const parent = fake.sessions.get(PARENT)
        if (parent) parent.time = { busy: 9, idle: 2 }
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a child that starts running while the facts are collected blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd === "status --porcelain") {
        const child = fake.sessions.get(CHILD)
        if (child) child.time = { busy: 9, idle: 2 }
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a denial recorded while the facts are collected blocks the removal", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd.startsWith("stash list")) {
        writeLanding(common, {
          receiptId: "r1",
          worktree: WT,
          headRefOid: TIP,
          sessionID: PARENT,
          landedAt: 1,
          denied: { at: 5, sessionID: PARENT },
        })
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a hold the idle gate set for a running shell is respected by the event pass until the gate sees it clear", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    const gate = (background: unknown[]) => fake.fire.session("experimental.idle", { sessionID: PARENT, background } as never)
    await gate([{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 30" }])
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await gate([])
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("the sweep respects a hold the gate set", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 })
    await fake.fire.session("experimental.idle", {
      sessionID: PARENT,
      background: [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 30" }],
    } as never)
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { plan: Array<{ verdict: string }> } }>
    const result = await execute({ mode: "prune" }, tool)
    expect(result.metadata.plan[0]?.verdict).toBe("quarantine")
    expect(worktree).toEqual([])
    await cleanup()
  })
})
