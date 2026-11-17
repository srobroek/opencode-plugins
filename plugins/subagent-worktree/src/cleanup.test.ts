import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CleanupDeps, createCleanup, decideCleanup, type GitFacts, GRACE_MS, LEASE_MS, type Presence, parseListed } from "./cleanup.ts"
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
}

const NO_GH = async (): Promise<RunResult> => ({ code: 127, stdout: "", stderr: "gh is not installed" })

function setup(over: { lowDiskBytes?: number; free?: (lane: Lane) => number; gh?: CleanupDeps["gh"] } = {}, name = "lane-x"): Setup {
  const fx = fixture()
  const lane = fx.lane(name)
  fx.storage.set(`lane/${lane.child}`, lane)
  const state = { owner: "idle" as Presence, parent: "idle" as Presence, lastActivity: 0, inside: "none" as const as "none" | "some" | "unknown", now: GRACE_MS * 10 }
  const reports: Setup["reports"] = []
  const logs: string[] = []
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
    removeWorktree: async (l, real) => {
      const result = await spawnRunner(["git", "-C", l.parentDir, "worktree", "remove", real])
      if (result.code !== 0) throw new Error(result.stderr)
    },
    report: async (_l, parent, text) => void reports.push({ parent, text }),
    withLane: (_child, work) => work(),
    gh: over.gh ?? NO_GH,
    runWithInput: spawnWithInput,
    freeBytes: async () => (over.free ? over.free(lane) : undefined),
    lowDiskBytes: over.lowDiskBytes ?? 0,
    log: (text) => void logs.push(text),
  }
  return {
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
const clean = (over: Partial<GitFacts> = {}): GitFacts => ({ dirty: false, ahead: 0, merged: false, pushed: false, busy: false, ...over })

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

/** Squash `lane` into main the way a PR squash-merge does and return the squash commit. */
function squashInto(s: Setup): string {
  git(s.fx.repo, "merge", "-q", "--squash", s.lane.branch)
  git(s.fx.repo, "commit", "-q", "-m", "squash")
  return git(s.fx.repo, "rev-parse", "HEAD")
}

describe("finished pull requests", () => {
  test("a squash-merged lane (gh says MERGED) is removed; the branch stays because -d refuses it", async () => {
    const s = setup({ gh: reply(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc" } })) })
    commitIn(s.lane.directory)
    squashInto(s)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed", branchDeleted: false })
    expect(existsSync(s.lane.directory)).toBe(false)
    expect(git(s.fx.repo, "branch", "--list", s.lane.branch)).toContain(s.lane.branch)
  })

  test("gh runs in the lane's worktree with the branch name and no shell", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const s = setup({
      gh: async (args, cwd) => {
        calls.push({ args, cwd })
        return reply(JSON.stringify({ state: "MERGED" }))()
      },
    })
    commitIn(s.lane.directory)
    const real = realpathSync(s.lane.directory)
    await s.clean.clean(s.lane.child)
    expect(calls).toEqual([{ args: ["pr", "view", s.lane.branch, "--json", "state,mergeCommit"], cwd: real }])
  })

  test("a closed, unmerged lane: the worktree is removed and the branch is kept", async () => {
    const s = setup({ gh: reply(JSON.stringify({ state: "CLOSED" })) })
    commitIn(s.lane.directory)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed", branchDeleted: false })
    expect(existsSync(s.lane.directory)).toBe(false)
    expect(git(s.fx.repo, "branch", "--list", s.lane.branch)).toContain(s.lane.branch)
  })

  test("an open pull request keeps the lane, and gh's answer is not asked again within the recheck window", async () => {
    let asked = 0
    const s = setup({
      gh: async () => {
        asked++
        return reply(JSON.stringify({ state: "OPEN" }))()
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

  test("offline gh: a one-to-one cherry-pick is found by git cherry", async () => {
    const s = setup({ gh: reply("", 1) })
    commitIn(s.lane.directory)
    git(s.fx.repo, "cherry-pick", s.lane.branch)
    expect(await s.clean.clean(s.lane.child)).toMatchObject({ action: "removed" })
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
    const s = setup({ gh: reply(JSON.stringify({ state: "MERGED" })) })
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
