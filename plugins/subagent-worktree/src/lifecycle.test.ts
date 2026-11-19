import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { claimGeneration, landingFile, readClaim, removeClaim, writeLanding } from "@srobroek/opencode-lib/worktree-claims"
import { lockedWrite, lockFile, readHolds, setHold, withDiskLock } from "@srobroek/opencode-lib/worktree-locks"
import { deleteDetached } from "./build-dirs.ts"
import type { RunResult } from "./git.ts"
import { createPlugin } from "./index.ts"
import { type Lane, laneKey } from "./lane.ts"
import { type BuildSeams, within } from "./lifecycle.ts"

const PARENT = "ses_parent"
const CHILD = "ses_child"
const REPO = "/repo"
const WT = "/wt/lane-a"
const BASE = "b".repeat(40)
const TIP = "t".repeat(40)
const TIP2 = "u".repeat(40)
const MAIN0 = "m".repeat(40)
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
  /** The tip is already reachable from the main commit the lane was created at: no work of its own. */
  inMainAtCreation?: boolean
  mergedHeads: string[]
  openBranches: string[]
  /** Heads of pull requests closed without merging. */
  closedHeads?: string[]
  /** Paths `git check-ignore` reports as not ignored. */
  notIgnored?: string[]
  /** The batched open pull request list: failing, or cut off at its 200-entry limit. */
  openList?: "fail" | "full"
  /** The lookup of open pull requests from one branch: failing, or finding one the batched list missed. */
  openByHead?: "fail" | "open"
  /** `git stash list` subjects. */
  stash?: string
  /** What `rev-parse --absolute-git-dir` and `--git-common-dir` answer to the build-directory code. */
  adminGitDir?: string
  commonGitDir?: string
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
  resumedByB?: boolean
  /** Paths that do not exist on disk, whatever `exists` says. */
  missing?: string[]
  /** Paths whose existence check fails with this errno code instead of answering. */
  statErrors?: Record<string, string>
  /** Called inside the host removal. */
  onRemove?: () => void
  /** Called with every git command before it is answered. */
  /** `log` is the asking instance's own command log, so a test can tell two instances apart. */
  onGit?: (cmd: string, log: string[][]) => Promise<void> | void
}

type Fake = ReturnType<typeof createFakeContext>

const lane = (over: Partial<Lane> = {}): Lane => ({
  child: CHILD,
  parent: PARENT,
  projectID: "prj",
  directory: WT,
  branch: "lane-a",
  base: BASE,
  mainAtCreation: MAIN0,
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
      if (argv.includes("--head")) {
        if (world.openByHead === "fail") return { code: 1, stdout: "", stderr: "gh: network down" }
        const head = argv[argv.indexOf("--head") + 1] ?? ""
        return ok(JSON.stringify(world.openByHead === "open" || world.openBranches.includes(head) ? [{ number: 1 }] : []))
      }
      if (argv.includes("closed")) return ok(JSON.stringify((world.closedHeads ?? []).map((headRefOid) => ({ headRefOid }))))
      if (argv.includes("merged")) return ok(JSON.stringify(world.mergedHeads.map((headRefOid) => ({ headRefOid }))))
      if (world.openList === "fail") return { code: 1, stdout: "", stderr: "gh: network down" }
      if (world.openList === "full") return ok(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ headRefName: `other-${i}` }))))
      return ok(JSON.stringify(world.openBranches.map((headRefName) => ({ headRefName }))))
    }
    if (argv[0] === "wt") {
      const items = world.integratedHeads.map((sha) => ({ branch: "lane-a", head: { sha }, display: { state: "integrated" } }))
      return ok(JSON.stringify({ items }))
    }
    if (argv[1] === "-c" && argv.includes("--absolute-git-dir")) return world.adminGitDir ? ok(`${world.adminGitDir}\n`) : { code: 128, stdout: "", stderr: "" }
    if (argv[1] === "-c" && argv.includes("--git-common-dir")) return world.commonGitDir ? ok(`${world.commonGitDir}\n`) : { code: 128, stdout: "", stderr: "" }
    if (argv.includes("check-ignore")) return { code: world.notIgnored?.includes(argv.at(-1) ?? "") ? 1 : 0, stdout: "", stderr: "" }
    if (argv.includes("ls-files")) return ok()
    const cmd = argv.slice(3).join(" ")
    await world.onGit?.(cmd, log)
    if (cmd.startsWith("rev-list --count")) return ok(`${world.ahead}\n`)
    if (cmd === "status --porcelain") return ok(world.porcelain)
    if (cmd.startsWith("rev-parse --verify --quiet HEAD")) return ok(`${world.head}\n`)
    if (cmd.startsWith("rev-parse --verify --quiet refs/heads/")) return ok(`${world.branchOid}\n`)
    if (cmd === "symbolic-ref --quiet --short HEAD") return world.onBranch ? ok("lane-a\n") : { code: 1, stdout: "", stderr: "" }
    if (cmd.startsWith("update-ref -d")) return { code: world.updateRefFails ? 1 : 0, stdout: "", stderr: "" }
    if (cmd.startsWith("merge-base --is-ancestor")) {
      // Only the commit the proof was about is an ancestor; a different tip is not.
      const [, , oid, ref] = cmd.split(" ")
      if (ref === MAIN0) return { code: world.inMainAtCreation && oid === TIP ? 0 : 1, stdout: "", stderr: "" }
      return { code: world.ancestor === 0 && oid === TIP ? 0 : 1, stdout: "", stderr: "" }
    }
    if (cmd === "rev-parse --absolute-git-dir") return ok("/nonexistent/gitdir\n")
    if (cmd.startsWith("stash list")) return ok(world.stash ?? "")
    return ok()
  }
}

async function start(
  world: Partial<World> = {},
  options: {
    stored?: Lane[]
    options?: Record<string, unknown>
    sweepDelayMs?: number
    debounceMs?: number
    /** Share the git common directory and the world with another instance. */
    common?: string
    /** Make the git common directory `<tmp>/main-checkout/.git`, so the repository has a canonical main checkout distinct from the project root. */
    mainCheckout?: boolean
    world?: World
    lock?: Record<string, unknown>
    build?: BuildSeams
  } = {},
) {
  const state: World = options.world ?? {
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
      remove: async (input: Record<string, unknown>) => {
        worktree.push({ method: "remove", input })
        state.onRemove?.()
      },
      refresh: async (input: Record<string, unknown>) => void worktree.push({ method: "refresh", input }),
    },
  })
  const makeCommon = () => {
    if (!options.mainCheckout) return mkdtempSync(join(tmpdir(), "common-"))
    const root = mkdtempSync(join(tmpdir(), "repo-"))
    COMMONS.push(root)
    mkdirSync(join(root, "main-checkout", ".git"), { recursive: true })
    return join(root, "main-checkout", ".git")
  }
  const common = options.common ?? makeCommon()
  if (!options.common && !options.mainCheckout) COMMONS.push(common)
  const log: string[][] = []
  const plugin = createPlugin({
    commonDir: async () => common,
    run: runner(state, log),
    lookupMs: 20,
    directoryExists: async (path: string) => {
      const code = state.statErrors?.[path]
      if (code !== undefined) throw Object.assign(new Error(`cannot stat ${path}`), { code })
      return state.exists && !(state.missing ?? []).includes(path)
    },
    now: () => state.now,
    debounceMs: options.debounceMs ?? 1,
    age: async () => state.age,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.sweepDelayMs === undefined ? {} : { sweepDelayMs: options.sweepDelayMs }),
  })
  const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
  return { fake, state, worktree, log, cleanup, common }
}

const stored = (fake: Fake, child = CHILD) => fake.storage.get(laneKey(child)) as Lane
const synthetic = (fake: Fake) =>
  fake.calls.filter((entry) => entry.method === "session.synthetic").map((entry) => entry.input as { sessionID: string; text: string })
const settle = (ms = 30) => new Promise((done) => setTimeout(done, ms))
/** Wait until `condition` holds (a pass does real file I/O and takes longer under load than a fixed sleep), or `ms` pass. */
const until = async (condition: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await settle(10)
}
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

describe("a closed pull request that was never merged", () => {
  const old = 3 * 24 * 3_600_000
  const prune = (fake: Fake) => {
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { plan: Array<{ verdict: string }> } }>
    return execute({ mode: "prune" }, tool)
  }

  test("loses its worktree through the verified removal and keeps its branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 1, age: old, closedHeads: [TIP] })
    expect((await prune(fake)).metadata.plan.map((entry) => entry.verdict)).toEqual(["prune"])
    expect(worktree[0]).toEqual({ method: "remove", input: { projectID: "prj", directory: WT, force: false } })
    expect(log.some((argv) => argv.includes("update-ref"))).toBe(false)
    expect(log.some((argv) => argv.includes("branch") && argv.includes("-D"))).toBe(false)
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  test("is kept while another pull request from the branch is open", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 1, age: old, closedHeads: [TIP], openBranches: ["lane-a"] })
    expect((await prune(fake)).metadata.plan[0]?.verdict).not.toBe("prune")
    expect(worktree).toEqual([])
    await cleanup()
  })

  test.each([
    ["the open pull request list fails", { openList: "fail" }],
    ["the open pull request list is cut off at its limit", { openList: "full" }],
    ["the fresh lookup for the branch fails under the lock", { openByHead: "fail" }],
    ["a pull request from the branch opened after the list was read", { openByHead: "open" }],
  ] as const)("is kept when %s", async (_name, over) => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 1, age: old, closedHeads: [TIP], ...over })
    await prune(fake)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    expect(log.some((argv) => argv.includes("update-ref"))).toBe(false)
    await cleanup()
  })

  test("is kept when no pull request is known, or the closed one covers another commit", async () => {
    const unknown = await start({ ancestor: 1, age: old })
    expect((await prune(unknown.fake)).metadata.plan[0]?.verdict).not.toBe("prune")
    expect(unknown.worktree).toEqual([])
    await unknown.cleanup()
    const other = await start({ ancestor: 1, age: old, closedHeads: [TIP2] })
    expect((await prune(other.fake)).metadata.plan[0]?.verdict).not.toBe("prune")
    expect(other.worktree).toEqual([])
    await other.cleanup()
  })

  test("is kept when the tree has changes, the owner is live, or it is too young", async () => {
    const dirty = await start({ ancestor: 1, age: old, closedHeads: [TIP], porcelain: " M a\n" })
    expect((await prune(dirty.fake)).metadata.plan[0]?.verdict).toBe("quarantine")
    await dirty.cleanup()
    const live = await start({ ancestor: 1, age: old, closedHeads: [TIP], time: { [CHILD]: { busy: 9, idle: 2 } } })
    ;(live.fake.context.session as unknown as { list: unknown }).list = async () => ({ data: [{ id: CHILD, time: { busy: 9, idle: 2 } }] })
    expect((await prune(live.fake)).metadata.plan[0]?.verdict).toBe("keep")
    expect(live.worktree).toEqual([])
    await live.cleanup()
    const young = await start({ ancestor: 1, age: 1000, closedHeads: [TIP] })
    expect((await prune(young.fake)).metadata.plan[0]?.verdict).toBe("keep")
    await young.cleanup()
  })
})

describe("build directories of a kept lane whose owner is gone", () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  const GRACE = 30 * 60_000

  /**
   * A real directory for the lane, with a build directory, a plain one and a link out, laid out as a linked
   * worktree: `<base>/repo/.git/worktrees/lane` is its own git directory and names `<dir>/.git` back.
   */
  const laneDir = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "free-build-")))
    roots.push(base)
    const dir = join(base, "lane")
    const outside = join(base, "outside")
    const commonGitDir = join(base, "repo", ".git")
    const adminGitDir = join(commonGitDir, "worktrees", "lane")
    for (const path of [join(dir, "target"), join(dir, "dist"), join(dir, "src"), outside, adminGitDir]) mkdirSync(path, { recursive: true })
    for (const file of [join(dir, "target", "a"), join(dir, "dist", "a"), join(dir, "src", "a"), join(outside, "keep")]) writeFileSync(file, "x")
    writeFileSync(join(dir, ".git"), `gitdir: ${adminGitDir}\n`)
    writeFileSync(join(adminGitDir, "gitdir"), `${join(dir, ".git")}\n`)
    return { dir, outside, adminGitDir, commonGitDir }
  }
  type Started = Awaited<ReturnType<typeof start>> & ReturnType<typeof laneDir> & { sessions: unknown[] }
  const run = async (
    over: {
      world?: Partial<World>
      options?: Record<string, unknown>
      sessions?: unknown[]
      freeBytes?: (path: string) => Promise<number | undefined>
      mode?: string
      lock?: Record<string, unknown>
      /** Seams that act on the started plugin; called only while the sweep runs. */
      build?: (s: Started) => BuildSeams
    } = {},
  ) => {
    const dirs = laneDir()
    const holder = {} as Started
    const seams: BuildSeams = { ...over.build?.(holder), ...(over.freeBytes ? { freeBytes: over.freeBytes } : {}) }
    const started = await start(
      { ancestor: 1, openBranches: ["lane-a"], adminGitDir: dirs.adminGitDir, commonGitDir: dirs.commonGitDir, ...over.world },
      {
        stored: [lane({ directory: dirs.dir })],
        options: { sweep: "report", freeBuildDirs: true, ...over.options },
        build: seams,
        ...(over.lock ? { lock: over.lock } : {}),
      },
    )
    const sessions = [...(over.sessions ?? [])]
    Object.assign(holder, started, dirs, { sessions })
    ;(started.fake.context.session as unknown as { list: unknown }).list = async () => ({ data: sessions })
    const execute = started.fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<{ content: string }>
    const result = await execute({ mode: over.mode ?? "prune" }, tool)
    return { ...holder, result }
  }
  const resumeCall = {
    tool: "subagent",
    sessionID: PARENT,
    agent: "build",
    messageID: "m",
    id: "call",
    input: { agent: "general", prompt: "follow up", sessionID: CHILD },
  }

  // Each change happens after the sweep read its facts and before the lock is taken: only the fresh checks under the lock can see it.
  type Change = (s: Started) => Promise<void>
  const changes: Array<[string, Change]> = [
    ["the lane is resumed", async (s) => void (await s.fake.fire.tool("execute.before", resumeCall as never))],
    ["running work is recorded", async (s) => void setHold(s.common, s.dir, "ses_x", [{ kind: "shell", id: "sh1" }], NOW)],
    ["the tree gains a change", async (s) => {
      s.state.porcelain = " M src/a\n"
    }],
    ["a stash appears on the branch", async (s) => {
      s.state.stash = "On lane-a: wip\n"
    }],
    ["a session starts in the worktree", async (s) => void s.sessions.push({ id: CHILD, time: { busy: 9, idle: 2 } })],
  ]
  test.each(changes)("when %s after the facts were read, nothing is freed", async (_name, change) => {
    let changed = false
    const r = await run({
      build: (s) => ({
        beforeLock: async () => {
          await change(s)
          changed = true
        },
      }),
    })
    expect(changed).toBe(true)
    expect(existsSync(join(r.dir, "target", "a"))).toBe(true)
    await r.cleanup()
  })

  test("deleting the detached directory holds no lock: a resume and a hold write meanwhile go through", async () => {
    const failures: unknown[] = []
    let generations: number[] = []
    const r = await run({
      // A held lock would make these fail after 50 ms instead of waiting.
      lock: { waitMs: 50 },
      build: (s) => ({
        deleteTrash: async (detached) => {
          if (detached.rel !== "target") return deleteDetached(detached)
          try {
            expect(existsSync(join(s.dir, "target"))).toBe(false)
            const before = claimGeneration(readClaim(s.common, s.dir))
            await s.fake.fire.tool("execute.before", resumeCall as never)
            generations = [before, claimGeneration(readClaim(s.common, s.dir))]
            await lockedWrite(s.common, s.dir, { sessionID: "ses_x", waitMs: 50, now: () => NOW }, () =>
              setHold(s.common, s.dir, "ses_x", [{ kind: "shell", id: "sh1" }], NOW),
            )
            // The resumed child builds again: the new directory is not the detached one.
            mkdirSync(join(s.dir, "target"))
            writeFileSync(join(s.dir, "target", "new"), "x")
          } catch (error) {
            failures.push(error)
          }
          return deleteDetached(detached)
        },
      }),
    })
    expect(failures).toEqual([])
    expect(generations[1]).toBeGreaterThan(generations[0] ?? Number.POSITIVE_INFINITY)
    expect(readHolds(r.common, r.dir).holds.map((hold) => hold.sessionID)).toContain("ses_x")
    expect(existsSync(join(r.dir, "target", "new"))).toBe(true)
    expect(readdirSync(join(r.adminGitDir, "opencode-trash"))).toEqual([])
    expect(existsSync(join(r.outside, "keep"))).toBe(true)
    await r.cleanup()
  })

  test("an ignored build directory is freed; a directory git does not ignore, and source, stay", async () => {
    const r = await run({ world: { notIgnored: ["dist"] } })
    expect(existsSync(join(r.dir, "target"))).toBe(false)
    expect(existsSync(join(r.dir, "dist", "a"))).toBe(true)
    expect(existsSync(join(r.dir, "src", "a"))).toBe(true)
    expect(r.worktree).toEqual([])
    await r.cleanup()
  })

  test("a link out of the lane is not followed", async () => {
    const dirs = laneDir()
    rmSync(join(dirs.dir, "target"), { recursive: true })
    symlinkSync(dirs.outside, join(dirs.dir, "target"))
    const started = await start(
      { ancestor: 1, openBranches: ["lane-a"], adminGitDir: dirs.adminGitDir, commonGitDir: dirs.commonGitDir },
      { stored: [lane({ directory: dirs.dir })], options: { sweep: "report", freeBuildDirs: true } },
    )
    ;(started.fake.context.session as unknown as { list: unknown }).list = async () => ({ data: [] })
    const execute = started.fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<unknown>
    await execute({ mode: "prune" }, tool)
    expect(existsSync(join(dirs.outside, "keep"))).toBe(true)
    expect(existsSync(join(dirs.dir, "target"))).toBe(true)
    await started.cleanup()
  })

  test("a live owner keeps everything", async () => {
    const r = await run({ sessions: [{ id: CHILD, time: { busy: 9, idle: 2 } }] })
    expect(existsSync(join(r.dir, "target", "a"))).toBe(true)
    await r.cleanup()
  })

  test("an owner gone for less than the grace period keeps everything", async () => {
    const r = await run({ sessions: [{ id: CHILD, time: { busy: 1, idle: 2, updated: NOW - GRACE / 3 } }] })
    expect(existsSync(join(r.dir, "target", "a"))).toBe(true)
    await r.cleanup()
  })

  test("low free disk drops the grace period", async () => {
    const recent = [{ id: CHILD, time: { busy: 1, idle: 2, updated: NOW - GRACE / 3 } }]
    const low = await run({ sessions: recent, options: { lowDiskBytes: 1000 }, freeBytes: async () => 10 })
    expect(existsSync(join(low.dir, "target"))).toBe(false)
    await low.cleanup()
    const roomy = await run({ sessions: recent, options: { lowDiskBytes: 1000 }, freeBytes: async () => 5000 })
    expect(existsSync(join(roomy.dir, "target", "a"))).toBe(true)
    await roomy.cleanup()
  })

  test("a live session still blocks it on a low disk", async () => {
    const r = await run({ sessions: [{ id: CHILD, time: { busy: 9, idle: 2 } }], options: { lowDiskBytes: 1000 }, freeBytes: async () => 10 })
    expect(existsSync(join(r.dir, "target", "a"))).toBe(true)
    await r.cleanup()
  })

  test("a tree with changes keeps its build directories", async () => {
    const r = await run({ world: { porcelain: " M src/a\n" } })
    expect(existsSync(join(r.dir, "target", "a"))).toBe(true)
    await r.cleanup()
  })

  test("running work recorded on disk keeps them", async () => {
    const dirs = laneDir()
    const started = await start(
      { ancestor: 1, openBranches: ["lane-a"], adminGitDir: dirs.adminGitDir, commonGitDir: dirs.commonGitDir },
      { stored: [lane({ directory: dirs.dir })], options: { sweep: "report", freeBuildDirs: true } },
    )
    setHold(started.common, dirs.dir, "ses_x", [{ kind: "shell", id: "sh1" }], NOW)
    ;(started.fake.context.session as unknown as { list: unknown }).list = async () => ({ data: [] })
    const execute = started.fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<unknown>
    await execute({ mode: "prune" }, tool)
    expect(existsSync(join(dirs.dir, "target", "a"))).toBe(true)
    await started.cleanup()
  })

  test("a report sweep, or freeBuildDirs off, deletes nothing; the report names the directories", async () => {
    const report = await run({ mode: "report" })
    expect(existsSync(join(report.dir, "target", "a"))).toBe(true)
    expect(report.result.content).toContain("build directories can be freed")
    await report.cleanup()
    const off = await run({ options: { freeBuildDirs: false } })
    expect(existsSync(join(off.dir, "target", "a"))).toBe(true)
    await off.cleanup()
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

  test("a parent turn that starts during the final ref read blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd.startsWith("rev-parse --verify --quiet refs/heads/")) {
        const parent = fake.sessions.get(PARENT)
        if (parent) parent.time = { busy: 9, idle: 2 }
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("the child session is put back where it was when the final check refuses after the move", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd.startsWith("rev-parse --verify --quiet refs/heads/")) {
        const parent = fake.sessions.get(PARENT)
        if (parent) parent.time = { busy: 9, idle: 2 }
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    const moves = fake.calls.filter((entry) => entry.method === "session.move").map((entry) => (entry.input as { directory: string }).directory)
    // Whatever was moved home during the attempt is moved back to the lane.
    if (moves.length > 0) expect(moves.at(-1)).toBe(WT)
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

describe("the sweep re-checks ownership under the removal lock, for every candidate", () => {
  const execute = (fake: Fake) =>
    fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { plan: Array<{ verdict: string }> } }>

  test("a session that starts in an abandoned worktree after the facts were collected keeps it", async () => {
    // No lane record: only an old worktree under an included root.
    const { fake, worktree, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 }, { stored: [], options: { include: ["/wt"] } })
    let calls = 0
    ;(fake.context.session as unknown as { list: unknown }).list = async () => {
      calls++
      return calls === 1 ? { data: [] } : { data: [{ id: "late", time: { busy: 9, idle: 2 } }] }
    }
    const result = await execute(fake)({ mode: "prune" }, tool)
    expect(result.metadata.plan[0]?.verdict).toBe("prune")
    expect(calls).toBeGreaterThan(1)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a lookup that fails at removal time keeps it too", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 }, { stored: [], options: { include: ["/wt"] } })
    let calls = 0
    ;(fake.context.session as unknown as { list: unknown }).list = async () => {
      calls++
      if (calls === 1) return { data: [] }
      throw new Error("down")
    }
    await execute(fake)({ mode: "prune" }, tool)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("with no one in it at removal time, an abandoned worktree is pruned", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 }, { stored: [], options: { include: ["/wt"] } })
    ;(fake.context.session as unknown as { list: unknown }).list = async () => ({ data: [] })
    await execute(fake)({ mode: "prune" }, tool)
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("two plugin instances, one repository: coordination lives on disk", () => {
  const resumeCall = {
    tool: "subagent",
    sessionID: PARENT,
    agent: "build",
    messageID: "m",
    id: "call-resume",
    input: { agent: "general", prompt: "one more thing", sessionID: CHILD },
  }

  test("instance B resuming the lane while instance A collects its facts cancels A's removal", async () => {
    const a = await start({ ancestor: 0 })
    const b = await start({}, { common: a.common, world: a.state })
    a.state.onGit = async (cmd) => {
      if (cmd === "status --porcelain" && !a.state.resumedByB) {
        a.state.resumedByB = true
        await b.fake.fire.tool("execute.before", resumeCall as never)
      }
    }
    a.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(a.state.resumedByB).toBe(true)
    expect(a.worktree).toEqual([])
    await a.cleanup()
    await b.cleanup()
  })

  test("a resume instance B recorded before A's pass began keeps the lane through the resume window", async () => {
    const a = await start({ ancestor: 1 })
    const b = await start({}, { common: a.common, world: a.state })
    // A makes sure the claim exists, then B resumes (bumping the generation on disk).
    a.fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    await b.fake.fire.tool("execute.before", resumeCall as never)
    a.state.ancestor = 0 // now landed
    a.state.now += 60_000
    a.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(a.worktree).toEqual([])
    await a.cleanup()
    await b.cleanup()
  })

  test("a live lock held by another instance keeps the removal from running", async () => {
    const lockOptions = { waitMs: 40, ttlMs: 60_000, alive: () => true, host: "this-host", now: () => NOW }
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 }, { lock: lockOptions })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    mkdirSync(join(common, "opencode", "locks"), { recursive: true })
    writeFileSync(
      lockFile(common, WT),
      JSON.stringify({ pid: process.pid, host: "this-host", owner: "other", token: "theirs", taken: NOW, expires: NOW + 60_000 }),
    )
    state.ancestor = 0 // now landed
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    expect(JSON.parse(readFileSync(lockFile(common, WT), "utf8")).token).toBe("theirs")
    await cleanup()
  })

  test("a stale lock (old, holder dead) is broken and the removal runs", async () => {
    const lockOptions = { waitMs: 5000, ttlMs: 60_000, alive: () => false, host: "this-host", now: () => NOW }
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 }, { lock: lockOptions })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    mkdirSync(join(common, "opencode", "locks"), { recursive: true })
    writeFileSync(
      lockFile(common, WT),
      JSON.stringify({ pid: 999_999, host: "this-host", owner: "dead", token: "old", taken: NOW - 3_600_000, expires: NOW - 3_000_000 }),
    )
    state.ancestor = 0 // now landed
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => worktree.length > 0)
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("background work is held on disk by every gate", () => {
  const gate = (fake: Fake, sessionID: string, background: unknown[]) =>
    fake.fire.session("experimental.idle", { sessionID, background } as never)

  test("the child's own gate reports a running shell; the parent going idle afterwards does not remove the lane", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    await gate(fake, CHILD, [{ kind: "shell", sessionID: CHILD, shellID: "sh1", command: "sleep 60" }])
    expect(readHolds(common, WT).holds.map((hold) => hold.sessionID)).toEqual([CHILD])
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("once the child's gate sees nothing running, the hold clears and the lane is removed", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    await gate(fake, CHILD, [{ kind: "shell", sessionID: CHILD, shellID: "sh1", command: "sleep 60" }])
    await gate(fake, CHILD, [])
    expect(readHolds(common, WT).holds).toEqual([])
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("a hold that cannot be read blocks the removal", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    setHold(common, WT, "ses_x", [{ kind: "shell", id: "x" }], NOW)
    const root = join(common, "opencode", "holds")
    writeFileSync(join(root, readdirSync(root)[0] as string, "bad.json"), "garbage")
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a hold older than the expiry (a crashed host) no longer blocks", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    setHold(common, WT, "ses_x", [{ kind: "shell", id: "x" }], NOW - 25 * 3_600_000)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("coordination errors never escape a hook and never remove", () => {
  const needsPermissions = process.getuid?.() === 0 ? test.skip : test
  const lockStore = (common: string) => chmodSync(join(common, "opencode"), 0o555)
  const unlockStore = (common: string) => chmodSync(join(common, "opencode"), 0o755)

  needsPermissions("an unwritable store: the idle hook resolves, nothing is removed", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0 // landed now
    lockStore(common)
    try {
      await fake.fire.session("experimental.idle", {
        sessionID: PARENT,
        background: [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }],
      } as never)
      expect(worktree).toEqual([])
      await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
      expect(worktree).toEqual([])
    } finally {
      unlockStore(common)
    }
    await cleanup()
  })

  needsPermissions("an unwritable store: the event pass removes nothing and the sweep reports without throwing", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1, age: 3 * 24 * 3_600_000 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0
    lockStore(common)
    try {
      fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await settle()
      expect(worktree).toEqual([])
      const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { plan: unknown[] } }>
      await expect(execute({ mode: "prune" }, tool)).resolves.toBeDefined()
      expect(worktree).toEqual([])
    } finally {
      unlockStore(common)
    }
    await cleanup()
  })

  test("delivery holding the shared lock keeps the lane remover out, then it proceeds when released", async () => {
    const lockOptions = { waitMs: 40, ttlMs: 60_000, alive: () => true, host: "this-host", now: () => NOW }
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 }, { lock: lockOptions })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0
    mkdirSync(join(common, "opencode", "locks"), { recursive: true })
    const path = lockFile(common, WT)
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: "this-host", owner: "delivery", token: "delivery", taken: NOW, expires: NOW + 60_000 }))
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    rmSync(path)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("an unwritable holds store stays unsafe across passes", () => {
  const needsPermissions = process.getuid?.() === 0 ? test.skip : test
  const gate = (fake: Fake, background: unknown[]) =>
    fake.fire.session("experimental.idle", { sessionID: PARENT, background } as never)

  needsPermissions("readable holds directory with only expired records, a failed write, then a later event: no removal", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0
    // Only an expired record: the directory exists and reads as empty.
    setHold(common, WT, "ses_old", [{ kind: "shell", id: "old" }], NOW - 25 * 3_600_000)
    const holdsRoot = join(common, "opencode", "holds")
    const holds = join(holdsRoot, readdirSync(holdsRoot)[0] as string)
    chmodSync(holds, 0o555)
    try {
      // The gate cannot record the child's running shell: that must be remembered ...
      await gate(fake, [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }])
      expect(worktree).toEqual([])
      // ... for the passes that follow, not just this invocation.
      fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await settle()
      expect(worktree).toEqual([])
    } finally {
      chmodSync(holds, 0o755)
    }
    await cleanup()
  })

  needsPermissions("the unsafe state ends with a later hold write that succeeds", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0
    setHold(common, WT, "ses_old", [{ kind: "shell", id: "old" }], NOW - 25 * 3_600_000)
    const holdsRoot = join(common, "opencode", "holds")
    const holds = join(holdsRoot, readdirSync(holdsRoot)[0] as string)
    chmodSync(holds, 0o555)
    await gate(fake, [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }])
    chmodSync(holds, 0o755)
    // Writable again, but the earlier failure is only forgotten by a write that succeeds.
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await gate(fake, [])
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("sessions are moved out of a worktree before it is removed", () => {
  const moves = (fake: Fake) =>
    fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input as { sessionID: string; directory: string })
  const addSession = (fake: Fake, id: string, directory: string, time: Record<string, number> = { busy: 1, idle: 2 }) =>
    fake.sessions.set(id, { id, projectID: "prj", location: { directory }, time })

  test("an idle session of another tool inside the lane is moved to the checkout first, then the worktree goes", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    addSession(fake, "ses_other", WT)
    let movedAtRemoval: string[] = []
    state.onRemove = () => {
      movedAtRemoval = moves(fake).map((move) => move.sessionID)
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => worktree.some((entry) => entry.method === "remove"))
    expect(movedAtRemoval).toContain("ses_other")
    expect(moves(fake).find((move) => move.sessionID === "ses_other")).toEqual({ sessionID: "ses_other", directory: REPO })
    await cleanup()
  })

  test("an archived idle session inside the lane is moved out too", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    addSession(fake, "ses_shelved", WT, { busy: 9, idle: 2, archived: 3 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => worktree.some((entry) => entry.method === "remove"))
    expect(moves(fake).find((move) => move.sessionID === "ses_shelved")).toEqual({ sessionID: "ses_shelved", directory: REPO })
    await cleanup()
  })

  test("a running session inside blocks the removal", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    addSession(fake, "ses_busy", `${WT}/pkg`, { busy: 9, idle: 2 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle(150)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a failed move blocks the removal, and the lane's own child is put back", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    addSession(fake, "ses_other", WT)
    const session = fake.context.session as unknown as { move: (input: { sessionID: string; directory: string }) => Promise<unknown> }
    const original = session.move.bind(session)
    session.move = (input) => (input.sessionID === "ses_other" ? Promise.reject(new Error("host refused")) : original(input))
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle(150)
    expect(worktree).toEqual([])
    expect(moves(fake).filter((move) => move.sessionID === CHILD).at(-1)?.directory).toBe(WT)
    await cleanup()
  })

  test("a sweep removal moves sessions out as well", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0, age: 3 * 24 * 3_600_000 })
    addSession(fake, "ses_other", WT)
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<unknown>
    await execute({ mode: "prune" }, tool)
    expect(worktree.some((entry) => entry.method === "remove")).toBe(true)
    expect(moves(fake).some((move) => move.sessionID === "ses_other")).toBe(true)
    await cleanup()
  })
})

describe("the repair pass heals sessions stranded by earlier removals", () => {
  const addSession = (fake: Fake, id: string, directory: string) =>
    fake.sessions.set(id, { id, projectID: "prj", location: { directory }, time: { busy: 1, idle: 2 } })
  const moved = (fake: Fake) =>
    fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input as { sessionID: string; directory: string })

  test("a session whose directory is gone is moved to the project's checkout; one with an existing directory is left alone", async () => {
    const { fake, cleanup } = await start({ missing: ["/wt/removed-long-ago"] }, { options: { sweep: "report" }, sweepDelayMs: 80 })
    addSession(fake, "ses_stranded", "/wt/removed-long-ago")
    addSession(fake, "ses_fine", "/wt/still-here")
    await until(() => moved(fake).length > 0)
    expect(moved(fake)).toEqual([{ sessionID: "ses_stranded", directory: REPO }])
    await cleanup()
  })

  test("a stranded lane child goes to its lane's parent checkout", async () => {
    const { fake, cleanup } = await start(
      { missing: [WT] },
      { options: { sweep: "report" }, sweepDelayMs: 80, stored: [lane({ parentDir: "/other/checkout", state: "removed" })] },
    )
    await until(() => moved(fake).length > 0)
    expect(moved(fake).find((move) => move.sessionID === CHILD)).toEqual({ sessionID: CHILD, directory: "/other/checkout" })
    await cleanup()
  })

  const addWith = (fake: Fake, id: string, directory: string, over: { projectID?: string; time?: Record<string, number> } = {}) =>
    fake.sessions.set(id, { id, projectID: over.projectID ?? "prj", location: { directory }, time: over.time ?? { busy: 1, idle: 2 } })

  test("a running stranded session is never moved", async () => {
    const { fake, cleanup } = await start({ missing: ["/wt/gone"] }, { options: { sweep: "report" }, sweepDelayMs: 80 })
    addWith(fake, "ses_running", "/wt/gone", { time: { busy: 9, idle: 2 } })
    addWith(fake, "ses_idle", "/wt/gone")
    await until(() => moved(fake).length > 0)
    await settle(60)
    expect(moved(fake).map((move) => move.sessionID)).toEqual(["ses_idle"])
    await cleanup()
  })

  test.each(["EACCES", "EIO"])("a %s from the existence check moves nothing: unknown is not gone", async (code) => {
    const { fake, cleanup } = await start({ statErrors: { "/wt/unsure": code } }, { options: { sweep: "report" }, sweepDelayMs: 80 })
    addWith(fake, "ses_unsure", "/wt/unsure")
    await settle(300)
    expect(moved(fake)).toEqual([])
    await cleanup()
  })

  test("a stranded session of another project is not touched", async () => {
    const { fake, cleanup } = await start({ missing: ["/wt/gone"] }, { options: { sweep: "report" }, sweepDelayMs: 80 })
    addWith(fake, "ses_mine", "/wt/gone")
    addWith(fake, "ses_theirs", "/wt/gone", { projectID: "other-project" })
    await until(() => moved(fake).length > 0)
    await settle(60)
    expect(moved(fake).map((move) => move.sessionID)).toEqual(["ses_mine"])
    await cleanup()
  })

  test("an archived stranded session is repaired as well", async () => {
    const { fake, cleanup } = await start({ missing: ["/wt/gone"] }, { options: { sweep: "report" }, sweepDelayMs: 80 })
    addWith(fake, "ses_shelved", "/wt/gone", { time: { busy: 1, idle: 2, archived: 3 } })
    await until(() => moved(fake).length > 0)
    expect(moved(fake)).toEqual([{ sessionID: "ses_shelved", directory: REPO }])
    await cleanup()
  })

  /**
   * The three destinations are told apart: the lane's stored parent checkout, the repository's canonical
   * main checkout (the parent of `<common>/.git`), and the project root (REPO). Here the main checkout is a
   * real directory that is neither of the other two.
   */
  describe("destination order: stored parent, then canonical main checkout, then the project root", () => {
    const PARENT_CHECKOUT = "/gone/linked-checkout"
    const run = async (missing: (main: string) => string[]) => {
      // The main checkout's path is only known once the fixture exists, so `missing` is filled in afterwards.
      const state = { missing: [] as string[] }
      const errors: string[] = []
      const spy = console.error
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "))
      try {
        const started = await start(
          { missing: state.missing },
          {
            options: { sweep: "report" },
            sweepDelayMs: 150,
            mainCheckout: true,
            stored: [lane({ parentDir: PARENT_CHECKOUT, state: "removed" })],
          },
        )
        const main = dirname(started.common)
        expect(main).not.toBe(REPO)
        state.missing.push(WT, ...missing(main))
        return { ...started, main, errors, restore: () => (console.error = spy) }
      } catch (error) {
        console.error = spy
        throw error
      }
    }

    test("parent missing: the canonical main checkout wins", async () => {
      const t = await run(() => [PARENT_CHECKOUT])
      await until(() => moved(t.fake).length > 0)
      t.restore()
      expect(moved(t.fake).find((move) => move.sessionID === CHILD)).toEqual({ sessionID: CHILD, directory: t.main })
      await t.cleanup()
    })

    test("parent and main checkout missing: the project root wins", async () => {
      const t = await run((main) => [PARENT_CHECKOUT, main])
      await until(() => moved(t.fake).length > 0)
      t.restore()
      expect(moved(t.fake).find((move) => move.sessionID === CHILD)).toEqual({ sessionID: CHILD, directory: REPO })
      await t.cleanup()
    })

    test("all three missing: nothing is moved, and the session is reported as failed", async () => {
      const t = await run((main) => [PARENT_CHECKOUT, main, REPO])
      await until(() => t.errors.some((line) => line.includes("no existing destination")), 3000)
      t.restore()
      expect(moved(t.fake)).toEqual([])
      expect(t.errors.join("\n")).toContain(`could not move session ${CHILD} out of ${WT}: no existing destination`)
      await t.cleanup()
    })

    test("the stored parent is preferred when it exists", async () => {
      const t = await run(() => [])
      await until(() => moved(t.fake).length > 0)
      t.restore()
      expect(moved(t.fake).find((move) => move.sessionID === CHILD)).toEqual({ sessionID: CHILD, directory: PARENT_CHECKOUT })
      await t.cleanup()
    })
  })

  test("with the sweep off, nothing is repaired", async () => {
    const { fake, cleanup } = await start({ missing: ["/wt/removed-long-ago"] }, { options: { sweep: "off" }, sweepDelayMs: 80 })
    addSession(fake, "ses_stranded", "/wt/removed-long-ago")
    await settle(120)
    expect(moved(fake)).toEqual([])
    await cleanup()
  })
})

describe("each lane notice is sent once, and only for a lane that is still there", () => {
  const DIRTY = " M a.txt\n"
  const idleHook = (fake: Fake, sessionID: string) => fake.fire.session("experimental.idle", { sessionID, background: [] } as never)
  const landedDirty = { ancestor: 0, porcelain: DIRTY }

  test("the same landed-dirty condition through events, the idle hook and a second instance sends one notice", async () => {
    const one = await start(landedDirty)
    const two = await start({}, { world: one.state, common: one.common })
    for (const instance of [one, two]) {
      instance.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await settle()
      await idleHook(instance.fake, PARENT)
      one.state.now += 20_000
      await idleHook(instance.fake, PARENT)
      instance.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await settle()
    }
    const sent = [...synthetic(one.fake), ...synthetic(two.fake)]
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("has landed, but /wt/lane-a has uncommitted changes")
    expect(sent[0]?.sessionID).toBe(PARENT)
    await one.cleanup()
    await two.cleanup()
  })

  test("a different dirty state is a new notice", async () => {
    const { fake, state, cleanup } = await start(landedDirty)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    state.porcelain = " M b.txt\n"
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toHaveLength(2)
    await cleanup()
  })

  test("a worktree removed after the facts were read gets no notice, and its lane is repaired", async () => {
    let reads = 0
    const { fake, state, cleanup } = await start({
      ...landedDirty,
      onGit: (cmd) => {
        if (cmd === "status --porcelain" && ++reads === 2) state.exists = false
      },
    })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    expect(stored(fake).state).toBe("removed")
    await cleanup()
  })

  test("a tree that became clean after the facts were read gets no notice", async () => {
    let reads = 0
    const { fake, state, cleanup } = await start({
      ...landedDirty,
      onGit: (cmd) => {
        if (cmd === "status --porcelain" && ++reads === 3) state.porcelain = ""
      },
    })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a lane retired after the facts were read gets no notice", async () => {
    let reads = 0
    const { fake, common, cleanup } = await start({
      ...landedDirty,
      onGit: (cmd) => {
        if (cmd === "status --porcelain" && ++reads === 2) {
          removeClaim(common, WT)
          fake.storage.set(laneKey(CHILD), lane({ state: "landed" }))
        }
      },
    })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a lane whose child is running gets no notice from an event or the idle hook", async () => {
    const { fake, cleanup } = await start({ ...landedDirty, time: { [CHILD]: { busy: 5, idle: 2 } } })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await idleHook(fake, PARENT)
    await idleHook(fake, CHILD)
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a failed child is still announced while it reads as running", async () => {
    const { fake, cleanup } = await start({ time: { [CHILD]: { busy: 5, idle: 2 } } })
    fake.emit({ type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } })
    await settle()
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })
})

describe("a lane with no commits of its own is empty, never landed", () => {
  // Its recorded base is old, so it is "27 ahead", but every commit is already in main.
  const noWork = { ahead: 27, ancestor: 0, inMainAtCreation: true }

  test("a dirty one whose child is running gets no notice and is not classified as landed", async () => {
    const { fake, worktree, cleanup } = await start({ ...noWork, porcelain: " M a.txt\n", time: { [CHILD]: { busy: 5, idle: 2 } } })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(fake).filter((entry) => entry.text.includes("has landed"))).toEqual([])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a dirty one whose child finished gets no landed notice either", async () => {
    const { fake, cleanup } = await start({ ...noWork, porcelain: " M a.txt\n" })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(fake).filter((entry) => entry.text.includes("has landed"))).toEqual([])
    await cleanup()
  })

  test("the removal path does not remove it as landed", async () => {
    const { fake, worktree, cleanup } = await start(noWork)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(worktree.filter((entry) => entry.method === "remove")).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a lane recorded before mainAtCreation existed is not landed by ancestry alone", async () => {
    const { mainAtCreation: _unused, ...old } = lane()
    const { fake, worktree, cleanup } = await start({ ancestor: 0 }, { stored: [old] })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.filter((entry) => entry.method === "remove")).toEqual([])
    await cleanup()
  })

  test("a lane that really landed is still removed", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.some((entry) => entry.method === "remove")).toBe(true)
    await cleanup()
  })

  test("an empty, clean lane is still removed after the grace period", async () => {
    const { fake, state, worktree, cleanup } = await start({ ahead: 0, head: BASE, branchOid: BASE }, { stored: [lane({ quietSince: NOW - 3_600_000 * 24 })] })
    state.now = NOW
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.some((entry) => entry.method === "remove")).toBe(true)
    await cleanup()
  })
})

describe("a notice whose send failed is retried until its reservation is released", () => {
  const DIRTY = " M a.txt\n"
  const landedDirty = { ancestor: 0, porcelain: DIRTY }
  const noticesDir = (common: string) => join(common, "opencode", "lane-notices")
  type Instance = Awaited<ReturnType<typeof start>>
  // An idle hook for a session with no lanes still runs on the lifecycle's one chain: awaiting it waits for a pass in flight.
  const drain = (fake: Fake) => fake.fire.session("experimental.idle", { sessionID: "ses_unrelated", background: [] } as never)

  /** Make the next synthetic message fail, after `during` ran (where a test breaks the rollback). */
  const rejectNextSend = (fake: Fake, during: () => Promise<void> | void = () => {}) => {
    const session = fake.context.session as unknown as { synthetic: (input: unknown) => Promise<unknown> }
    const original = session.synthetic
    let attempts = 0
    session.synthetic = async (input) => {
      if (++attempts > 1) return original(input)
      await during()
      throw new Error("host refused the message")
    }
    return () => attempts
  }

  const paths = {
    event: async ({ fake, state }: Instance) => {
      // The pass's first `rev-list` read means it is running on the chain, whether or not it then sends.
      const running = new Promise<void>((done) => {
        state.onGit = (cmd) => {
          if (!cmd.startsWith("rev-list --count")) return
          state.onGit = undefined
          done()
        }
      })
      fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await running
      await drain(fake)
    },
    idle: async ({ fake }: Instance) => {
      await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    },
  }

  /** What breaks the rollback while the send is failing; `restore` undoes it once that pass is over. */
  const breakages: Record<string, (instance: Instance) => { during: () => Promise<void> | void; restore: () => Promise<void> | void }> = {
    "nothing (the send alone fails)": () => ({ during: () => {}, restore: () => {} }),
    "another holder of the lane lock": ({ common }) => {
      let free!: () => void
      let held: Promise<unknown> = Promise.resolve()
      return {
        during: async () => {
          let taken!: () => void
          const acquired = new Promise<void>((done) => (taken = done))
          held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
            taken()
            await new Promise<void>((done) => (free = done))
          })
          await acquired
        },
        restore: async () => {
          free()
          await held
        },
      }
    },
    "a notice file that cannot be written": ({ common }) => ({
      during: () => chmodSync(noticesDir(common), 0o500), // check-test-executables: directory permission, not a script
      restore: () => chmodSync(noticesDir(common), 0o700), // check-test-executables: directory permission, not a script
    }),
  }

  for (const [path, trigger] of Object.entries(paths)) {
    for (const [breakage, make] of Object.entries(breakages)) {
      test(`${path} path, rollback blocked by ${breakage}: the next pass sends it once`, async () => {
        const instance = await start(landedDirty, { lock: { waitMs: 50 } })
        const broken = make(instance)
        const attempted = rejectNextSend(instance.fake, broken.during)
        await trigger(instance)
        expect(attempted()).toBe(1)
        expect(synthetic(instance.fake)).toEqual([])
        await broken.restore()
        instance.state.now += 20_000
        await trigger(instance)
        const sent = synthetic(instance.fake)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.text).toContain("has landed, but /wt/lane-a has uncommitted changes")
        await trigger(instance)
        expect(attempted()).toBe(2)
        expect(synthetic(instance.fake)).toHaveLength(1)
        await instance.cleanup()
      })
    }
  }

  test("a reservation still held at shutdown is released then, so another instance can send it", async () => {
    const one = await start(landedDirty, { lock: { waitMs: 50 } })
    const attempted = rejectNextSend(one.fake, () => chmodSync(noticesDir(one.common), 0o500)) // check-test-executables: directory permission, not a script
    await paths.idle(one)
    expect(attempted()).toBe(1)
    chmodSync(noticesDir(one.common), 0o700) // check-test-executables: directory permission, not a script
    await one.cleanup()
    const two = await start({}, { world: one.state, common: one.common })
    await paths.idle(two)
    expect(synthetic(two.fake)).toHaveLength(1)
    await two.cleanup()
  })
})

describe("two instances racing for one notice", () => {
  test("overlapping passes deliver it exactly once", async () => {
    // Each instance's second `rev-list` is the fresh read inside its reservation. The first to get there
    // waits until the other has also got there (no lock: both would send) or is waiting on the lane lock.
    let release!: () => void
    const overlapping = new Promise<void>((done) => (release = done))
    const reads = new Map<string[][], number>()
    let inside = 0
    const world: World = {
      ahead: 2, porcelain: " M a.txt\n", ancestor: 0, mergedHeads: [], openBranches: [], time: {}, exists: true, now: NOW,
      age: undefined, head: TIP, branchOid: TIP, onBranch: true, integratedHeads: [], updateRefFails: false,
      onGit: async (cmd, log) => {
        if (!cmd.startsWith("rev-list --count")) return
        const count = (reads.get(log) ?? 0) + 1
        reads.set(log, count)
        if (count !== 2) return
        if (++inside === 2) release()
        await overlapping
      },
    }
    // A wait on a held lock is the other half of the barrier; yield to the event loop rather than sleep.
    const lock = { sleep: () => new Promise<void>((done) => { release(); setImmediate(done) }) }
    const one = await start({}, { world, lock })
    const two = await start({}, { world, common: one.common, lock })
    one.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    two.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await overlapping
    await until(() => synthetic(one.fake).length + synthetic(two.fake).length > 0)
    await one.cleanup()
    await two.cleanup()
    const sent = [...synthetic(one.fake), ...synthetic(two.fake)]
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("has landed, but /wt/lane-a has uncommitted changes")
  })
})

describe("the idle gate's message carries only the notices this instance reserved", () => {
  const CHILD2 = "ses_child2"
  const WT2 = "/wt/lane-b"

  test("of two landed-dirty lanes, one already announced elsewhere, the message names only the other", async () => {
    const both = [lane(), lane({ child: CHILD2, directory: WT2, branch: "lane-b" })]
    const one = await start({ ancestor: 0, porcelain: " M a.txt\n" }, { stored: both })
    one.fake.sessions.set(CHILD2, { id: CHILD2, parentID: PARENT, projectID: "prj", location: { directory: WT2 }, time: { busy: 1, idle: 2 } })
    // A second instance that only knows lane a announces it first.
    const two = await start({}, { world: one.state, common: one.common })
    await two.fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(two.fake).map((entry) => entry.text)).toEqual([
      "<system-reminder>Lane lane-a (subagent ses_child) has landed, but /wt/lane-a has uncommitted changes, so its worktree was kept. Commit, stash or discard them and it can be removed.</system-reminder>",
    ])
    await one.fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(one.fake)).toEqual([
      {
        sessionID: PARENT,
        text: "<system-reminder>Lane lane-b (subagent ses_child2) has landed, but /wt/lane-b has uncommitted changes, so its worktree was kept. Commit, stash or discard them and it can be removed.</system-reminder>",
      },
    ])
    await one.cleanup()
    await two.cleanup()
  })
})

describe("within: a path is the root or below it", () => {
  test.each([
    ["/wt/a", "/wt/a", true],
    ["/wt/a/b", "/wt/a", true],
    ["/wt/ab", "/wt/a", false],
    ["/wt", "/wt/a", false],
    ["/wt/a", "/wt/a///", true],
    ["/wt/a/b", "/wt/a/", true],
    ["/x", "/", true],
    ["/", "/", true],
    ["", "", true],
    ["x", "", false],
    ["//wt/a", "//wt", true],
  ] as const)("%p within %p is %p", (path, root, expected) => {
    expect(within(path, root)).toBe(expected)
  })

  test("a root with a long run of slashes before its last character is read in linear time", () => {
    // The unanchored /\/+$/ took about 1 s on 50k slashes and grows with the square: 200k took 30 s, past the test timeout.
    const root = `${"/".repeat(200_000)}x`
    expect(within(`${root}/y`, root)).toBe(true)
    expect(within(root.slice(1), root)).toBe(false)
  })
})
