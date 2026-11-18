import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CleanupDeps,
  createCleanup,
  createDirectoryFence,
  type DirectoryFence,
  decideCleanup,
  type GitFacts,
  GRACE_MS,
  LEASE_MS,
  neutralizers,
  type Presence,
  parseListed,
  removeBuildDir,
} from "./cleanup.ts"
import { type RunResult, spawnGh, spawnRunner, spawnWithInput } from "./git.ts"
import { type Lane, LEASE_KEY, pendingKey } from "./lane.ts"

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "lane-cleanup-")))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...IDENT, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

let counter = 0

type Fixture = {
  repo: string
  root: string
  /** Create a lane worktree on a new branch and return its lane record. */
  lane: (name?: string) => Lane
  storage: Map<string, unknown>
}

/** A repository with one commit on main and a worktree root beside it. */
function fixture(): Fixture {
  const base = join(SCRATCH, `case${++counter}`)
  const repo = join(base, "repo")
  const root = join(base, "worktrees")
  mkdirSync(repo, { recursive: true })
  mkdirSync(root)
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, ".gitignore"), "target/\nnode_modules/\n")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  const commonDir = realpathSync(join(repo, ".git"))
  const lane = (name = "lane-x"): Lane => {
    const directory = join(root, name)
    git(repo, "worktree", "add", "-q", "-b", `lane/${name}`, directory)
    return {
      child: `ses_${name}`,
      parent: "ses_parent",
      projectID: "prj",
      directory,
      branch: `lane/${name}`,
      base: git(repo, "rev-parse", "main"),
      target: "main",
      parentDir: repo,
      state: "active",
      ownership: { createdAt: 0, physical: realpathSync(directory), root: realpathSync(root), commonDir, strategy: "host" },
    }
  }
  return { repo, root, lane, storage: new Map() }
}

type Setup = {
  clean: ReturnType<typeof createCleanup>
  reports: Array<{ parent: Presence; text: string }>
  logs: string[]
  lane: Lane
  fx: Fixture
  set: (patch: Partial<{ owner: Presence; parent: Presence; lastActivity: number; inside: "none" | "some" | "unknown"; now: number }>) => void
  saved: () => Lane
  fence: DirectoryFence
}

const NO_GH = async (): Promise<RunResult> => ({ code: 127, stdout: "", stderr: "gh is not installed" })

function setup(over: { lowDiskBytes?: number; free?: (lane: Lane) => number; gh?: CleanupDeps["gh"]; patch?: Partial<CleanupDeps> } = {}, name = "lane-x"): Setup {
  const fx = fixture()
  const lane = fx.lane(name)
  fx.storage.set(`lane/${lane.child}`, lane)
  const state = { owner: "idle" as Presence, parent: "idle" as Presence, lastActivity: 0, inside: "none" as const as "none" | "some" | "unknown", now: GRACE_MS * 10 }
  const reports: Setup["reports"] = []
  const logs: string[] = []
  const fence = createDirectoryFence(() => state.now, 60_000)
  const deps: CleanupDeps = {
    run: spawnRunner,
    now: () => state.now,
    storage: {
      get: async (key) => fx.storage.get(key),
      set: async (key, value) => void fx.storage.set(key, value),
      remove: async (key) => void fx.storage.delete(key),
      scan: async (prefix) => [...fx.storage.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    },
    lanes: async () => [...fx.storage.entries()].filter(([key]) => key.startsWith("lane/")).map(([, value]) => value as Lane),
    load: async (child) => fx.storage.get(`lane/${child}`) as Lane | undefined,
    save: async (next) => void fx.storage.set(`lane/${next.child}`, next),
    presence: async (id) => ({ presence: id === lane.child ? state.owner : state.parent, lastActivity: state.lastActivity }),
    runningInside: async () => state.inside,
    removeWorktree: async (l, real, guard) => {
      const result = await spawnRunner(["git", ...guard, "-C", l.parentDir, "worktree", "remove", real])
      if (result.code !== 0) throw new Error(result.stderr)
    },
    report: async (_l, parent, text) => void reports.push({ parent, text }),
    withLane: (_child, work) => work(),
    fence,
    gh: over.gh ?? NO_GH,
    runWithInput: spawnWithInput,
    freeBytes: async () => (over.free ? over.free(lane) : undefined),
    lowDiskBytes: over.lowDiskBytes ?? 0,
    log: (text) => void logs.push(text),
    ...over.patch,
  }
  return {
    fence,
    clean: createCleanup(deps),
    reports,
    logs,
    lane,
    fx,
    set: (patch) => void Object.assign(state, patch),
    saved: () => fx.storage.get(`lane/${lane.child}`) as Lane,
  }
}

const commitIn = (dir: string, file = "work.txt", text = "work\n") => {
  writeFileSync(join(dir, file), text)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", `edit ${file}`)
}

const ownerFacts = (git: GitFacts | undefined, over: Partial<Parameters<typeof decideCleanup>[0]> = {}) => ({
  owner: "idle" as Presence,
  parent: "idle" as Presence,
  inactiveMs: 0,
  graceMs: GRACE_MS,
  lowDisk: false,
  git,
  ...over,
})
const clean = (over: Partial<GitFacts> = {}): GitFacts => ({ head: "h", dirty: false, ahead: 0, merged: false, pushed: false, busy: false, ...over })

describe("decideCleanup", () => {
  test.each([
    ["unreadable git state", ownerFacts(undefined), "untouched"],
    ["a running owner", ownerFacts(clean(), { owner: "running" }), "untouched"],
    ["an unknown owner", ownerFacts(clean(), { owner: "unknown" }), "untouched"],
    ["an empty clean lane", ownerFacts(clean()), "remove"],
    ["a merged clean lane", ownerFacts(clean({ ahead: 2, merged: true })), "remove"],
    ["a dirty lane", ownerFacts(clean({ dirty: true })), "keep"],
    ["unpushed unmerged commits", ownerFacts(clean({ ahead: 1 })), "keep"],
    ["a busy git operation", ownerFacts(clean({ busy: true })), "keep"],
    ["pushed, parent alive", ownerFacts(clean({ ahead: 1, pushed: true })), "keep"],
    ["pushed, parent unknown", ownerFacts(clean({ ahead: 1, pushed: true }), { parent: "unknown" }), "keep"],
    ["pushed, parent gone", ownerFacts(clean({ ahead: 1, pushed: true }), { parent: "gone" }), "remove"],
  ] as const)("%s", (_name, facts, kind) => {
    expect(decideCleanup(facts).kind).toBe(kind)
  })

  test("pushed lane whose parent is gone keeps its branch; empty lane deletes it", () => {
    expect(decideCleanup(ownerFacts(clean({ ahead: 1, pushed: true }), { parent: "gone" }))).toMatchObject({ kind: "remove", branch: "keep" })
    expect(decideCleanup(ownerFacts(clean()))).toMatchObject({ kind: "remove", branch: "delete" })
  })

  test.each([
    ["owner gone", { owner: "gone" as Presence }, true],
    ["owner idle inside the grace", { inactiveMs: GRACE_MS - 1 }, false],
    ["owner idle past the grace", { inactiveMs: GRACE_MS }, true],
    ["low disk", { lowDisk: true }, true],
  ])("dirty lane frees build dirs: %s", (_name, over, expected) => {
    expect(decideCleanup(ownerFacts(clean({ dirty: true }), over))).toMatchObject({ kind: "keep", freeBuild: expected })
  })

  test.each([
    ["merged", { kind: "remove", branch: "delete" }],
    ["closed", { kind: "remove", branch: "keep" }],
  ] as const)("a lane whose pull request is %s is removed, unpushed or not", (done, expected) => {
    expect(decideCleanup(ownerFacts(clean({ ahead: 3, done })))).toMatchObject(expected)
  })

  test("a done lane that is dirty or busy is kept", () => {
    expect(decideCleanup(ownerFacts(clean({ ahead: 3, done: "merged", dirty: true })))).toMatchObject({ kind: "keep" })
    expect(decideCleanup(ownerFacts(clean({ ahead: 3, done: "closed", busy: true })))).toMatchObject({ kind: "keep" })
  })

  test("a busy operation never frees build dirs", () => {
    expect(decideCleanup(ownerFacts(clean({ busy: true }), { owner: "gone" }))).toMatchObject({ freeBuild: false })
  })
})

describe("parseListed", () => {
  test("reads paths and locks", () => {
    const out = "worktree /a\nHEAD x\nbranch refs/heads/main\n\nworktree /b\nHEAD y\nlocked reason\n\nworktree /c\nlocked\n"
    expect(parseListed(out)).toEqual([
      { path: "/a", locked: false },
      { path: "/b", locked: true },
      { path: "/c", locked: true },
    ])
  })
})

describe("clean", () => {
  test("a finished empty lane: worktree and branch go, the record is retired", async () => {
    const s = setup()
    const outcome = await s.clean.clean(s.lane.child)
    expect(outcome).toEqual({ action: "removed", reason: "it is empty", branchDeleted: true })
    expect(existsSync(s.lane.directory)).toBe(false)
    expect(git(s.fx.repo, "branch", "--list", s.lane.branch)).toBe("")
    expect(s.saved().state).toBe("removed")
  })

  test("a merged clean lane is removed with its branch", async () => {
    const s = setup()
    commitIn(s.lane.directory)
    git(s.fx.repo, "merge", "-q", "--no-ff", "-m", "merge", s.lane.branch)
    const outcome = await s.clean.clean(s.lane.child)
    expect(outcome).toMatchObject({ action: "removed", branchDeleted: true })
    expect(existsSync(s.lane.directory)).toBe(false)
  })

  test("an aborted lane (owner gone) with uncommitted work is kept, its build dir freed and the parent told once", async () => {
    let freed = false
    const s = setup({ free: (lane) => (existsSync(join(lane.directory, "target")) && !freed ? 1000 : 9000) })
    writeFileSync(join(s.lane.directory, "wip.txt"), "wip\n")
    mkdirSync(join(s.lane.directory, "target"))
    writeFileSync(join(s.lane.directory, "target", "big.bin"), "x".repeat(100))
    s.set({ owner: "gone" })
    const outcome = await s.clean.clean(s.lane.child)
    freed = true
    expect(outcome).toMatchObject({ action: "kept", reason: "it has uncommitted changes", freedBytes: 8000 })
    expect(existsSync(join(s.lane.directory, "wip.txt"))).toBe(true)
    expect(existsSync(join(s.lane.directory, "target"))).toBe(false)
    expect(s.reports).toHaveLength(1)
    expect(s.reports[0]?.text).toContain("uncommitted changes")
    await s.clean.clean(s.lane.child)
    expect(s.reports).toHaveLength(1)
  })

  test("a dirty lane with a live owner inside the grace keeps its build dir; past the grace it is freed", async () => {
    const s = setup()
    writeFileSync(join(s.lane.directory, "wip.txt"), "wip\n")
    mkdirSync(join(s.lane.directory, "target"))
    s.set({ now: 10 * GRACE_MS, lastActivity: 10 * GRACE_MS - 1000 })
    await s.clean.clean(s.lane.child)
    expect(existsSync(join(s.lane.directory, "target"))).toBe(true)
    s.set({ lastActivity: 10 * GRACE_MS - GRACE_MS })
    await s.clean.clean(s.lane.child)
    expect(existsSync(join(s.lane.directory, "target"))).toBe(false)
  })

  test("unpushed commits are never removed", async () => {
    const s = setup()
    commitIn(s.lane.directory)
    s.set({ owner: "gone", parent: "gone" })
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept", reason: "it has commits that are on no remote and not merged" })
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a pushed lane is kept while the parent lives and removed, branch kept, once it is gone", async () => {
    const s = setup()
    const remote = join(s.fx.repo, "..", "remote.git")
    git(s.fx.repo, "init", "-q", "--bare", remote)
    git(s.fx.repo, "remote", "add", "origin", remote)
    commitIn(s.lane.directory)
    git(s.lane.directory, "push", "-q", "origin", s.lane.branch)
    git(s.lane.directory, "fetch", "-q", "origin")
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept", reason: "it is pushed but not merged and its parent is still alive" })
    s.set({ parent: "gone" })
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed", branchDeleted: false })
    expect(existsSync(s.lane.directory)).toBe(false)
    expect(git(s.fx.repo, "branch", "--list", s.lane.branch)).toContain(s.lane.branch)
  })

  test.each(["running", "unknown"] as const)("a %s owner leaves the lane untouched", async (owner) => {
    const s = setup()
    s.set({ owner })
    expect((await s.clean.clean(s.lane.child)).action).toBe("untouched")
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a running session inside the worktree, or an unknown answer, leaves it untouched", async () => {
    const s = setup()
    for (const inside of ["some", "unknown"] as const) {
      s.set({ inside })
      expect((await s.clean.clean(s.lane.child)).action).toBe("untouched")
    }
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a restart: a fresh instance over the same stored record cleans the same lane, but not a resumed one", async () => {
    const s = setup()
    s.set({ owner: "running" })
    expect((await s.clean.clean(s.lane.child)).action).toBe("untouched")
    s.set({ owner: "idle" })
    expect((await s.clean.clean(s.lane.child)).action).toBe("removed")
  })

  test("a path that now resolves through a symlink is not the recorded one: untouched", async () => {
    const s = setup()
    const moved = `${s.lane.directory}-real`
    git(s.fx.repo, "worktree", "move", s.lane.directory, moved)
    symlinkSync(moved, s.lane.directory)
    const outcome = await s.clean.clean(s.lane.child)
    expect(outcome.action).toBe("untouched")
    expect(existsSync(moved)).toBe(true)
  })

  test("a record that points at another repository's checkout is untouched", async () => {
    const s = setup()
    const other = fixture()
    const foreign = other.lane("foreign")
    const lane: Lane = { ...s.lane, directory: foreign.directory, ownership: { ...(s.lane.ownership as NonNullable<Lane["ownership"]>), physical: realpathSync(foreign.directory), root: realpathSync(other.root) } }
    s.fx.storage.set(`lane/${lane.child}`, lane)
    expect((await s.clean.clean(lane.child)).action).toBe("untouched")
    expect(existsSync(foreign.directory)).toBe(true)
  })

  test("a lane without an ownership record is never touched", async () => {
    const s = setup()
    const { ownership: _drop, ...bare } = s.lane
    s.fx.storage.set(`lane/${s.lane.child}`, bare)
    expect((await s.clean.clean(s.lane.child)).action).toBe("untouched")
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a nested git init counts as uncommitted work", async () => {
    const s = setup()
    const nested = join(s.lane.directory, "vendor", "thing")
    mkdirSync(nested, { recursive: true })
    git(nested, "init", "-q")
    writeFileSync(join(nested, "x"), "x")
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept", reason: "it has uncommitted changes" })
    expect(existsSync(nested)).toBe(true)
  })

  test("a rebase in progress keeps the lane and frees nothing", async () => {
    const s = setup()
    s.set({ owner: "gone" })
    mkdirSync(join(s.lane.directory, "target"))
    const gitDir = git(s.lane.directory, "rev-parse", "--absolute-git-dir")
    mkdirSync(join(gitDir, "rebase-merge"))
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept", reason: "a git operation is in progress or the worktree is locked", freedBytes: 0 })
    expect(existsSync(join(s.lane.directory, "target"))).toBe(true)
  })

  test("a locked worktree is untouched", async () => {
    const s = setup()
    git(s.fx.repo, "worktree", "lock", s.lane.directory)
    expect((await s.clean.clean(s.lane.child)).action).toBe("untouched")
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a tracked dist/ survives while an ignored target/ is freed", async () => {
    const s = setup()
    mkdirSync(join(s.lane.directory, "dist"))
    writeFileSync(join(s.lane.directory, "dist", "index.js"), "built\n")
    git(s.lane.directory, "add", "-f", "dist/index.js")
    git(s.lane.directory, "commit", "-q", "-m", "dist")
    mkdirSync(join(s.lane.directory, "target"))
    writeFileSync(join(s.lane.directory, "wip.txt"), "wip\n")
    s.set({ owner: "gone" })
    await s.clean.clean(s.lane.child)
    expect(existsSync(join(s.lane.directory, "dist", "index.js"))).toBe(true)
    expect(existsSync(join(s.lane.directory, "target"))).toBe(false)
  })

  test("a build dir that is a symlink, or not ignored, is left alone", async () => {
    const s = setup()
    const elsewhere = join(s.fx.repo, "..", "elsewhere")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "keep"), "keep")
    symlinkSync(elsewhere, join(s.lane.directory, "target"))
    mkdirSync(join(s.lane.directory, "build"))
    writeFileSync(join(s.lane.directory, "build", "x"), "x")
    writeFileSync(join(s.lane.directory, "wip.txt"), "wip\n")
    s.set({ owner: "gone" })
    await s.clean.clean(s.lane.child)
    expect(existsSync(join(elsewhere, "keep"))).toBe(true)
    expect(existsSync(join(s.lane.directory, "build", "x"))).toBe(true)
  })

  test("low disk mode frees build dirs of an idle dirty lane inside the grace", async () => {
    const s = setup({ lowDiskBytes: 1_000_000, free: () => 10 })
    writeFileSync(join(s.lane.directory, "wip.txt"), "wip\n")
    mkdirSync(join(s.lane.directory, "target"))
    s.set({ now: 10 * GRACE_MS, lastActivity: 10 * GRACE_MS - 1000 })
    await s.clean.clean(s.lane.child)
    expect(existsSync(join(s.lane.directory, "target"))).toBe(false)
    expect(s.logs.some((line) => line.includes("low disk"))).toBe(true)
  })
})

describe("sweep", () => {
  test("cleans every owned active lane and skips a worktree a tool result names", async () => {
    const s = setup()
    const second = s.fx.lane("lane-y")
    s.fx.storage.set(`lane/${second.child}`, second)
    const result = await s.clean.sweep({ skip: [`landed ${second.directory}`] })
    expect(result).toEqual({ swept: 1 })
    expect(existsSync(s.lane.directory)).toBe(false)
    expect(existsSync(second.directory)).toBe(true)
  })

  test("another server's live lease skips the sweep; an expired one does not", async () => {
    const s = setup()
    s.fx.storage.set(LEASE_KEY, { holder: "other", until: s.fx.storage.size + GRACE_MS * 10 + LEASE_MS })
    expect(await s.clean.sweep()).toEqual({ swept: 0, skipped: "another server is sweeping" })
    s.fx.storage.set(LEASE_KEY, { holder: "other", until: 1 })
    expect(await s.clean.sweep()).toEqual({ swept: 1 })
    expect(s.fx.storage.has(LEASE_KEY)).toBe(false)
  })

  test("concurrent sweeps share one run", async () => {
    const s = setup()
    const [a, b] = [s.clean.sweep(), s.clean.sweep()]
    expect(a).toBe(b)
    await a
  })

  test("a stale pending record is logged and cleared; a fresh one is left", async () => {
    const s = setup()
    s.fx.storage.set(pendingKey("crashed"), { name: "crashed", parent: "p", projectID: "prj", createdAt: 0 })
    s.fx.storage.set(pendingKey("fresh"), { name: "fresh", parent: "p", projectID: "prj", createdAt: GRACE_MS * 10 })
    await s.clean.sweep()
    expect(s.fx.storage.has(pendingKey("crashed"))).toBe(false)
    expect(s.fx.storage.has(pendingKey("fresh"))).toBe(true)
    expect(s.logs.some((line) => line.includes("crashed"))).toBe(true)
  })
})

const reply = (stdout: string, code = 0) => async (): Promise<RunResult> => ({ code, stdout, stderr: code === 0 ? "" : "gh: failed" })

/** gh's answer for a pull request whose head is the lane's current commit (or `head`). */
const ghState =
  (state: string, head?: string): CleanupDeps["gh"] =>
  async (_args, cwd) => ({
    code: 0,
    stdout: JSON.stringify({ state, mergeCommit: { oid: "abc" }, headRefOid: head ?? git(cwd, "rev-parse", "HEAD") }),
    stderr: "",
  })

/** Squash `lane` into main the way a PR squash-merge does and return the squash commit. */
function squashInto(s: Setup): string {
  git(s.fx.repo, "merge", "-q", "--squash", s.lane.branch)
  git(s.fx.repo, "commit", "-q", "-m", "squash")
  return git(s.fx.repo, "rev-parse", "HEAD")
}

describe("finished pull requests", () => {
  test("a squash-merged lane (gh says MERGED) is removed; the branch stays because -d refuses it", async () => {
    const s = setup({ gh: ghState("MERGED") })
    commitIn(s.lane.directory)
    squashInto(s)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed", branchDeleted: false })
    expect(existsSync(s.lane.directory)).toBe(false)
    expect(git(s.fx.repo, "branch", "--list", s.lane.branch)).toContain(s.lane.branch)
  })

  test("gh runs in the lane's worktree with the branch name and no shell, and asks for the head commit", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const s = setup({
      gh: async (args, cwd) => {
        calls.push({ args, cwd })
        return ghState("MERGED")(args, cwd)
      },
    })
    commitIn(s.lane.directory)
    const real = realpathSync(s.lane.directory)
    await s.clean.clean(s.lane.child)
    expect(calls).toEqual([{ args: ["pr", "view", s.lane.branch, "--json", "state,mergeCommit,headRefOid"], cwd: real }])
  })

  test.each(["MERGED", "CLOSED"])("a %s pull request for a different head commit does not finish the lane", async (state) => {
    const s = setup({ gh: ghState(state, "0".repeat(40)) })
    commitIn(s.lane.directory)
    expect((await s.clean.clean(s.lane.child)).action).toBe("kept")
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a closed, unmerged lane: the worktree is removed and the branch is kept", async () => {
    const s = setup({ gh: ghState("CLOSED") })
    commitIn(s.lane.directory)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed", branchDeleted: false })
    expect(existsSync(s.lane.directory)).toBe(false)
    expect(git(s.fx.repo, "branch", "--list", s.lane.branch)).toContain(s.lane.branch)
  })

  test("an open pull request keeps the lane, and gh's answer is not asked again within the recheck window", async () => {
    let asked = 0
    const s = setup({
      gh: async (args, cwd) => {
        asked++
        return ghState("OPEN")(args, cwd)
      },
    })
    commitIn(s.lane.directory)
    expect((await s.clean.clean(s.lane.child)).action).toBe("kept")
    await s.clean.clean(s.lane.child)
    expect(asked).toBe(1)
    s.set({ now: 10 * GRACE_MS * 2 })
    await s.clean.clean(s.lane.child)
    expect(asked).toBe(2)
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("offline gh: a squash commit with the same combined patch-id counts as merged", async () => {
    const s = setup({ gh: reply("", 1) })
    commitIn(s.lane.directory, "one.txt", "one\n")
    commitIn(s.lane.directory, "two.txt", "two\n")
    squashInto(s)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed" })
    expect(existsSync(s.lane.directory)).toBe(false)
  })

  test("offline gh: a cherry-pick onto an advanced main is a different commit that git cherry still matches", async () => {
    const s = setup({ gh: reply("", 1) })
    commitIn(s.lane.directory)
    commitIn(s.fx.repo, "main-only.txt", "main\n")
    git(s.fx.repo, "cherry-pick", s.lane.branch)
    const mine = git(s.lane.directory, "rev-parse", "HEAD")
    expect(git(s.fx.repo, "rev-parse", "HEAD")).not.toBe(mine)
    expect(Bun.spawnSync(["git", "merge-base", "--is-ancestor", mine, "main"], { cwd: s.fx.repo }).exitCode).toBe(1)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed" })
  })

  test("a lane with a merge commit is not judged by git cherry, which skips merges", async () => {
    const s = setup({ gh: reply("", 1) })
    commitIn(s.lane.directory)
    git(s.fx.repo, "checkout", "-q", "-b", "side", "main")
    commitIn(s.fx.repo, "side.txt", "side\n")
    git(s.fx.repo, "checkout", "-q", "main")
    git(s.lane.directory, "merge", "-q", "--no-ff", "-m", "merge side", "side")
    git(s.fx.repo, "cherry-pick", `${s.lane.branch}^1`)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept" })
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("offline gh with no matching patch keeps the lane (fail closed)", async () => {
    const s = setup({ gh: reply("", 1) })
    commitIn(s.lane.directory)
    commitIn(s.fx.repo, "other.txt", "other\n")
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept", reason: "it has commits that are on no remote and not merged" })
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("gh that is not installed behaves like offline gh", async () => {
    const s = setup()
    commitIn(s.lane.directory)
    expect((await s.clean.clean(s.lane.child)).action).toBe("kept")
  })

  test("a squash-merged lane with uncommitted changes is kept", async () => {
    const s = setup({ gh: ghState("MERGED") })
    commitIn(s.lane.directory)
    squashInto(s)
    writeFileSync(join(s.lane.directory, "late.txt"), "late\n")
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept", reason: "it has uncommitted changes" })
    expect(existsSync(join(s.lane.directory, "late.txt"))).toBe(true)
  })

  test("the real gh runner reads a stub on PATH and reports a failing stub as a failure", async () => {
    const bin = join(SCRATCH, `gh-stub-${++counter}`)
    mkdirSync(bin)
    const stub = (body: string) => writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    const before = process.env.PATH
    process.env.PATH = `${bin}:${before ?? ""}`
    try {
      stub('echo \'{"state":"MERGED"}\'')
      expect(await spawnGh(["pr", "view", "x"], SCRATCH)).toMatchObject({ code: 0, stdout: expect.stringContaining("MERGED") })
      stub("echo offline >&2; exit 1")
      expect((await spawnGh(["pr", "view", "x"], SCRATCH)).code).toBe(1)
      process.env.PATH = "/nonexistent"
      expect((await spawnGh(["pr", "view", "x"], SCRATCH)).code).toBe(127)
    } finally {
      process.env.PATH = before
    }
  })
})

describe("the decision is bound to the commit it was made for", () => {
  const changed = (what: (s: Setup, cwd: string) => void) => {
    const holder: { s?: Setup } = {}
    const gh: CleanupDeps["gh"] = async (args, cwd) => {
      const answer = await ghState("MERGED")(args, cwd)
      what(holder.s as Setup, cwd)
      return answer
    }
    holder.s = setup({ gh })
    commitIn(holder.s.lane.directory)
    return holder.s
  }

  test("a new commit made while gh was asked keeps the lane", async () => {
    const s = changed((_s, cwd) => commitIn(cwd, "late.txt", "late\n"))
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "untouched", reason: "the lane changed while cleanup was deciding" })
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a file written while gh was asked keeps the lane", async () => {
    const s = changed((_s, cwd) => writeFileSync(join(cwd, "late.txt"), "late\n"))
    expect((await s.clean.clean(s.lane.child)).action).not.toBe("removed")
    expect(existsSync(join(s.lane.directory, "late.txt"))).toBe(true)
  })

  test("an owner that started running again while gh was asked keeps the lane", async () => {
    const s = changed((current) => current.set({ owner: "running" }))
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "untouched" })
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a session that started working inside the directory keeps the lane", async () => {
    const s = changed((current) => current.set({ inside: "some" }))
    expect((await s.clean.clean(s.lane.child)).action).toBe("untouched")
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a spawn into the directory while gh was asked keeps the lane", async () => {
    const s = changed((current, cwd) => void current.fence.pin(cwd))
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "untouched", reason: "a spawn or resume is using the worktree" })
    expect(existsSync(s.lane.directory)).toBe(true)
  })

  test("a spawn that arrives while the worktree is being removed is refused", async () => {
    let refused = ""
    const holder: { s?: Setup } = {}
    holder.s = setup({
      gh: ghState("MERGED"),
      patch: {
        removeWorktree: async (lane, real, guard) => {
          try {
            holder.s?.fence.pin(real)
          } catch (error) {
            refused = (error as Error).message
          }
          const result = await spawnRunner(["git", ...guard, "-C", lane.parentDir, "worktree", "remove", real])
          if (result.code !== 0) throw new Error(result.stderr)
        },
      },
    })
    commitIn(holder.s.lane.directory)
    expect((await holder.s.clean.clean(holder.s.lane.child)).action).toBe("removed")
    expect(refused).toContain("is being cleaned up")
  })
})

describe("directory fence", () => {
  test("a pinned directory cannot be claimed, until the hold after the spawn ends", () => {
    let now = 1000
    const fence = createDirectoryFence(() => now, 500)
    const end = fence.pin("/w/a")
    expect(fence.claim("/w/a")).toBeUndefined()
    end()
    expect(fence.claim("/w/a")).toBeUndefined()
    now += 500
    expect(fence.claim("/w/a")).toBeDefined()
  })

  test("a claimed directory refuses pins and a second claim until released", () => {
    const fence = createDirectoryFence(() => 0, 500)
    const release = fence.claim("/w/a")
    expect(release).toBeDefined()
    expect(() => fence.pin("/w/a")).toThrow("being cleaned up")
    expect(fence.claim("/w/a")).toBeUndefined()
    release?.()
    expect(fence.pin("/w/a")).toBeInstanceOf(Function)
  })

  test("other directories are unaffected", () => {
    const fence = createDirectoryFence(() => 0, 500)
    fence.pin("/w/a")
    expect(fence.claim("/w/b")).toBeDefined()
  })
})

describe("repository config cannot run programs", () => {
  /** A lane whose repository config defines clean, process and textconv drivers that write marker files. */
  function hostile(gh: CleanupDeps["gh"] = ghState("MERGED"), before?: (s: Setup) => void): { s: Setup; markers: Record<string, string> } {
    const s = setup({ gh })
    commitIn(s.lane.directory, "b.dat", "b\n")
    before?.(s)
    const dir = join(SCRATCH, `hostile-${++counter}`)
    mkdirSync(dir)
    const markers: Record<string, string> = {}
    const script = (name: string) => {
      const marker = join(dir, `${name}.ran`)
      markers[name] = marker
      const path = join(dir, `${name}.sh`)
      writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
      return path
    }
    git(s.fx.repo, "config", "filter.h.clean", script("clean"))
    git(s.fx.repo, "config", "filter.p.process", script("process"))
    git(s.fx.repo, "config", "diff.t.textconv", script("textconv"))
    git(s.fx.repo, "config", "diff.e.command", script("extdiff"))
    writeFileSync(join(s.fx.repo, ".git", "info", "attributes"), "* filter=h\na.txt filter=p\nb.dat diff=t\nwork.txt diff=e\n")
    // Stat-dirty files make git re-hash them through the clean filter.
    writeFileSync(join(s.lane.directory, "b.dat"), "b\n")
    writeFileSync(join(s.lane.directory, "a.txt"), "a\n")
    return { s, markers }
  }
  const ran = (markers: Record<string, string>) => Object.entries(markers).filter(([, path]) => existsSync(path)).map(([name]) => name)

  test("plain git does run them (the fixture is hostile)", () => {
    const { s, markers } = hostile()
    Bun.spawnSync(["git", "status", "--porcelain"], { cwd: s.lane.directory, stdin: "ignore" })
    Bun.spawnSync(["git", "diff", "HEAD~1", "HEAD"], { cwd: s.lane.directory, stdin: "ignore" })
    expect(ran(markers)).toEqual(expect.arrayContaining(["clean", "process"]))
  })

  test("cleanup, including the removal, never starts one", async () => {
    const { s, markers } = hostile()
    const outcome = await s.clean.clean(s.lane.child)
    expect(ran(markers)).toEqual([])
    expect(outcome.action).toBe("removed")
  })

  test("the offline patch-id path (diff and log -p) starts none either", async () => {
    const { s, markers } = hostile(reply("", 1), (current) => {
      commitIn(current.lane.directory, "work.txt", "work\n")
      squashInto(current)
    })
    const outcome = await s.clean.clean(s.lane.child)
    expect(ran(markers)).toEqual([])
    expect(outcome.action).toBe("removed")
  })

  test("freeing build dirs starts none", async () => {
    const { s, markers } = hostile()
    s.set({ owner: "gone" })
    mkdirSync(join(s.lane.directory, "target"))
    writeFileSync(join(s.lane.directory, "wip.txt"), "wip\n")
    await s.clean.clean(s.lane.child)
    expect(ran(markers)).toEqual([])
    expect(existsSync(join(s.lane.directory, "target"))).toBe(false)
  })

  test("a dirty tree is still seen as dirty with the drivers off", async () => {
    const { s, markers } = hostile()
    writeFileSync(join(s.lane.directory, "b.dat"), "changed\n")
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "kept", reason: "it has uncommitted changes" })
    expect(ran(markers)).toEqual([])
  })

  test("a lane with submodules is left alone", async () => {
    const s = setup()
    writeFileSync(join(s.lane.directory, ".gitmodules"), "")
    expect((await s.clean.clean(s.lane.child)).action).toBe("untouched")
    expect(existsSync(s.lane.directory)).toBe(true)
  })
})

describe("neutralizers", () => {
  const entry = (origin: string, key: string, value = "x") => `${origin}\0${key}\n${value}\0`
  const trusted = ["file:/home/u/.gitconfig"]

  test("repository drivers are blanked and the user's own are kept", () => {
    const out = entry("file:/repo/.git/config", "filter.h.clean") + entry("file:/home/u/.gitconfig", "filter.lfs.clean") + entry("file:/tmp/inc", "diff.t.textconv")
    expect(neutralizers(out, trusted)).toEqual(["-c", "filter.h.clean=", "-c", "diff.t.textconv="])
  })

  test("a key the user trusts is still blanked when the repository also sets it", () => {
    const out = entry("file:/home/u/.gitconfig", "filter.lfs.clean") + entry("file:/repo/.git/config", "filter.lfs.clean")
    expect(neutralizers(out, trusted)).toEqual(["-c", "filter.lfs.clean="])
  })

  test("a key that cannot be written as -c key= makes the answer unsafe", () => {
    expect(neutralizers(entry("file:/repo/.git/config", "filter.a=b.clean"), trusted)).toBeUndefined()
  })

  test("no drivers, no arguments", () => {
    expect(neutralizers("", trusted)).toEqual([])
  })
})

describe("build directory removal does not follow links", () => {
  const tree = () => {
    const root = realpathSync(mkdtempSync(join(SCRATCH, "bd-")))
    const outside = realpathSync(mkdtempSync(join(SCRATCH, "outside-")))
    mkdirSync(join(outside, ".cache"))
    writeFileSync(join(outside, ".cache", "keep"), "keep")
    return { root, outside }
  }

  test("a real directory is removed", async () => {
    const { root } = tree()
    mkdirSync(join(root, "node_modules", ".cache"), { recursive: true })
    writeFileSync(join(root, "node_modules", ".cache", "x"), "x")
    expect(await removeBuildDir(root, "node_modules/.cache")).toBe(true)
    expect(existsSync(join(root, "node_modules", ".cache"))).toBe(false)
    expect(existsSync(join(root, "node_modules"))).toBe(true)
    expect(readdirSync(join(root, "node_modules"))).toEqual([])
  })

  test("a symlinked build directory is refused", async () => {
    const { root, outside } = tree()
    symlinkSync(join(outside, ".cache"), join(root, "target"))
    expect(await removeBuildDir(root, "target")).toBe(false)
    expect(existsSync(join(outside, ".cache", "keep"))).toBe(true)
  })

  test("a symlinked intermediate directory is refused", async () => {
    const { root, outside } = tree()
    symlinkSync(outside, join(root, "node_modules"))
    expect(await removeBuildDir(root, "node_modules/.cache")).toBe(false)
    expect(existsSync(join(outside, ".cache", "keep"))).toBe(true)
  })

  test("an intermediate directory swapped for a link after the checks: the outside tree is put back untouched", async () => {
    const { root, outside } = tree()
    mkdirSync(join(root, "node_modules", ".cache"), { recursive: true })
    writeFileSync(join(root, "node_modules", ".cache", "mine"), "mine")
    const swap = () => {
      renameSync(join(root, "node_modules"), join(root, "node_modules.orig"))
      symlinkSync(outside, join(root, "node_modules"))
    }
    expect(await removeBuildDir(root, "node_modules/.cache", swap)).toBe(false)
    expect(existsSync(join(outside, ".cache", "keep"))).toBe(true)
    expect(readdirSync(outside).sort()).toEqual([".cache"])
    expect(existsSync(join(root, "node_modules.orig", ".cache", "mine"))).toBe(true)
  })

  test("through cleanup: a dirty abandoned lane whose node_modules was swapped leaves the outside directory alone", async () => {
    const { outside } = tree()
    const holder: { s?: Setup } = {}
    holder.s = setup({
      patch: {
        beforeBuildRename: () => {
          const dir = (holder.s as Setup).lane.directory
          renameSync(join(dir, "node_modules"), join(dir, "node_modules.orig"))
          symlinkSync(outside, join(dir, "node_modules"))
        },
      },
    })
    const s = holder.s
    writeFileSync(join(s.lane.directory, "wip.txt"), "wip\n")
    mkdirSync(join(s.lane.directory, "node_modules", ".cache"), { recursive: true })
    writeFileSync(join(s.lane.directory, "node_modules", ".cache", "mine"), "mine")
    s.set({ owner: "gone" })
    await s.clean.clean(s.lane.child)
    expect(existsSync(join(outside, ".cache", "keep"))).toBe(true)
    expect(readdirSync(outside).sort()).toEqual([".cache"])
    expect(existsSync(join(s.lane.directory, "node_modules.orig", ".cache", "mine"))).toBe(true)
  })
})

describe("shutdown", () => {
  test("after close, clean and sweep do nothing", async () => {
    const s = setup()
    s.clean.close()
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "untouched", reason: "cleanup is shutting down" })
    expect(await s.clean.sweep()).toEqual({ swept: 0, skipped: "cleanup is shutting down" })
    expect(existsSync(s.lane.directory)).toBe(true)
  })
})
