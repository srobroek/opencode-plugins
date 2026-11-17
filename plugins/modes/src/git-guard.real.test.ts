import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forbiddenGit, inspectGit } from "./git-guard.ts"
import { headRefusal } from "./head-guard.ts"

// Real git processes are slow on a loaded machine.
setDefaultTimeout(60_000)

// Real repositories: the user's checkout and a linked debug-* worktree that shares its object store and refs.
let home = ""
let repo = ""
let scratch = ""
let origin = ""

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "modes-real-git-")))
  repo = join(home, "repo")
  mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "one\n")
  git(repo, "add", "a.txt")
  git(repo, "commit", "-q", "-m", "init")
  scratch = join(home, ".local/share/opencode/worktree/h1/debug-foo")
  mkdirSync(join(home, ".local/share/opencode/worktree/h1"), { recursive: true })
  git(repo, "worktree", "add", "-q", "-b", "debug-foo", scratch)
  origin = join(home, "origin.git")
  git(home, "init", "-q", "--bare", "-b", "main", origin)
  git(repo, "remote", "add", "origin", origin)
  git(repo, "push", "-q", "origin", "main")
}, 60_000)
afterAll(() => rmSync(home, { recursive: true, force: true }))

const context = (workdir: string) => ({ home, startDir: repo, workdir })

describe("checkout boundary against real repositories", () => {
  test("a commit the guard allows in the scratch worktree leaves the user's checkout and its index alone", () => {
    writeFileSync(join(scratch, "a.txt"), "two\n")
    expect(forbiddenGit("git commit -am probe", "debug", context(scratch))).toBeUndefined()
    const before = { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain") }
    git(scratch, "commit", "-q", "-am", "probe")
    expect(git(repo, "rev-parse", "HEAD")).toBe(before.head)
    expect(git(repo, "status", "--porcelain")).toBe(before.status)
    expect(git(scratch, "rev-parse", "HEAD")).not.toBe(before.head)
  }, 30_000)

  test("bisect run and ordinary reads are allowed with the scratch workdir", () => {
    expect(forbiddenGit("git bisect run bun test x", "debug", context(scratch))).toBeUndefined()
    expect(forbiddenGit("git log -p", "debug", context(scratch))).toBeUndefined()
    expect(forbiddenGit(`git -C ${repo} log`, "debug", context(scratch))).toBeUndefined()
    expect(forbiddenGit("git status", "debug", context(repo))).toBeUndefined()
    expect(forbiddenGit("git diff", "debug", context(repo))).toBeUndefined()
  })

  // Each of these would run against the user's index or HEAD if it were allowed.
  const bypasses = (): string[] => [
    `git --work-tree=${repo} --git-dir=${scratch}/.git add -A`,
    `git --work-tree=${repo} add -A`,
    `git --git-dir=${repo}/.git commit -am x`,
    `git -C ${repo} commit -am x`,
    `GIT_DIR=${repo}/.git git commit -am x`,
    `GIT_WORK_TREE=${repo} git add -A`,
    `env -C ${repo} git commit -am x`,
    `env -C ${repo} sh -c 'git commit -am x'`,
    `cd ${repo} && git commit -am x`,
    `(cd ${repo} && git commit -am x)`,
    `sh -c 'git commit -am x'`,
    `git -C ${repo} bisect start`,
  ]
  test("every bypass of the workdir is refused even when the workdir is the scratch worktree", () => {
    for (const command of bypasses()) expect({ command, reason: forbiddenGit(command, "debug", context(scratch)) }).toEqual({ command, reason: expect.any(String) })
  })
  test("and with the user's checkout as workdir", () => {
    for (const command of ["git commit -am x", "git add -A", "git checkout main", "git stash", ...bypasses()])
      expect({ command, reason: forbiddenGit(command, "debug", context(repo)) }).toEqual({ command, reason: expect.any(String) })
  })
  test("refactor works in the checkout by design and is unaffected", () => {
    expect(forbiddenGit("git commit -am x", "refactor", context(repo))).toBeUndefined()
    expect(forbiddenGit(`git -C ${repo} add -A`, "refactor", context(repo))).toBeUndefined()
  })
})

/** Everything a bypass would change: HEAD, every ref, the config and the files in the user's checkout. */
const snapshot = () => ({
  head: git(repo, "rev-parse", "HEAD"),
  refs: git(repo, "for-each-ref"),
  config: git(repo, "config", "--list", "--local"),
  status: git(repo, "status", "--porcelain"),
  files: git(repo, "ls-files", "-s"),
})

/** The guard refuses every command, and (because none ran) the user's repository is exactly as it was. */
const refusedLeavesRepoUnchanged = (agents: string[], commands: string[]) => {
  const before = snapshot()
  for (const agent of agents)
    for (const command of commands)
      expect({ agent, command, reason: forbiddenGit(command, agent, context(scratch)) }).toEqual({ agent, command, reason: expect.any(String) })
  expect(snapshot()).toEqual(before)
}

describe("fetch against real repositories", () => {
  test("debug may not fetch, so HEAD, refs and config stay as they were", () => {
    refusedLeavesRepoUnchanged(["debug"], [
      "git fetch",
      "git fetch origin",
      "git fetch --update-head-ok origin +main:main",
      "git fetch origin +refs/heads/main:refs/heads/debug-foo",
    ])
  })
  test("refactor may fetch remote-tracking refs but not heads or HEAD", () => {
    refusedLeavesRepoUnchanged(["refactor"], [
      "git fetch --update-head-ok origin main:main",
      "git fetch origin +main:main",
      "git fetch origin main:refs/heads/x",
    ])
    expect(forbiddenGit("git fetch origin", "refactor", context(repo))).toBeUndefined()
    expect(forbiddenGit("git fetch origin refs/heads/main:refs/remotes/origin/main", "refactor", context(repo))).toBeUndefined()
  })
  test("the origin refs debug needs are already in the shared repository", () => {
    expect(git(scratch, "rev-parse", "origin/main")).toBe(git(repo, "rev-parse", "origin/main"))
  })
})

describe("apply against real repositories", () => {
  test("--directory and --unsafe-paths cannot point a patch outside the scratch worktree", () => {
    refusedLeavesRepoUnchanged(["debug", "refactor"], [
      `git apply --directory=${repo} p.diff`,
      "git apply --directory=../../../../../../../../repo p.diff",
      "git apply --unsafe-paths p.diff",
    ])
  })
  test("a plain apply is allowed under the scratch workdir", () => {
    expect(forbiddenGit("git apply p.diff", "debug", context(scratch))).toBeUndefined()
  })
})

describe("worktree against real repositories", () => {
  test("lock, move, repair and prune cannot touch the shared worktree metadata", () => {
    refusedLeavesRepoUnchanged(["debug", "refactor"], [
      `git worktree lock ${scratch}`,
      `git worktree move ${scratch} ${home}/moved`,
      "git worktree repair",
      "git worktree prune",
    ])
  })
  test("refactor cannot add or remove worktrees, and debug only scratch ones", () => {
    refusedLeavesRepoUnchanged(["refactor"], [`git worktree add ${home}/.local/share/opencode/worktree/h1/debug-bar`, `git worktree remove ${scratch}`])
    refusedLeavesRepoUnchanged(["debug"], [`git worktree add ${home}/sibling`, `git worktree remove ${repo}`])
    expect(forbiddenGit(`git worktree add --detach ${home}/.local/share/opencode/worktree/h1/debug-bar`, "debug", context(scratch))).toBeUndefined()
  })
})

describe("remote against real repositories", () => {
  test("changing, pruning or updating remotes would rewrite the shared config and refs", () => {
    refusedLeavesRepoUnchanged(["debug", "refactor"], [
      "git remote -v add evil https://example.com/x.git",
      "git remote --verbose set-url origin https://example.com/x.git",
      "git remote -v remove origin",
      "git remote -v rename origin o2",
      "git remote prune origin",
      "git remote -v update",
      "git remote set-head origin -a",
    ])
  })
  test("reading remotes is allowed", () => {
    for (const command of ["git remote -v", "git remote get-url origin", "git remote show -n origin"])
      expect(forbiddenGit(command, "debug", context(scratch))).toBeUndefined()
  })
})

describe("branch sharing against real repositories", () => {
  let lane = ""
  const mainRef = () => git(repo, "rev-parse", "refs/heads/main")
  const userState = () => ({
    head: git(repo, "rev-parse", "HEAD"),
    main: mainRef(),
    branch: git(repo, "symbolic-ref", "HEAD"),
    status: git(repo, "status", "--porcelain"),
  })

  beforeAll(() => {
    lane = join(home, ".local/share/opencode/worktree/h1/debug-seq")
    git(repo, "worktree", "add", "-q", "--detach", lane)
  }, 60_000)

  test("the bypass sequence is refused statically, and neither the user's HEAD nor main moves", () => {
    const before = userState()
    for (const command of [
      "git checkout --ignore-other-worktrees main",
      "git switch --ignore-other-worktrees main",
      "git checkout main",
      "git switch main",
      "git switch --force-create main",
      `git worktree add --force ${home}/.local/share/opencode/worktree/h1/debug-x main`,
      `git worktree add ${home}/.local/share/opencode/worktree/h1/debug-x main`,
    ])
      expect({ command, reason: forbiddenGit(command, "debug", context(lane)) }).toEqual({ command, reason: expect.any(String) })
    expect(userState()).toEqual(before)
  })

  test("if a worktree is on main anyway, the HEAD check refuses before a commit can move it", async () => {
    const before = userState()
    git(lane, "checkout", "-q", "--ignore-other-worktrees", "main")
    try {
      expect(await headRefusal(lane)).toContain("refs/heads/main")
      expect(userState()).toEqual(before)
    } finally {
      git(lane, "checkout", "-q", "--detach")
    }
  }, 30_000)

  test("a commit on debug/x in scratch works and leaves main alone", async () => {
    const before = userState()
    expect(forbiddenGit("git switch -c debug/x", "debug", context(lane))).toBeUndefined()
    git(lane, "switch", "-q", "-c", "debug/x")
    expect(await headRefusal(lane)).toBeUndefined()
    writeFileSync(join(lane, "b.txt"), "x\n")
    expect(forbiddenGit("git add -A", "debug", context(lane))).toBeUndefined()
    git(lane, "add", "-A")
    expect(forbiddenGit("git commit -m probe", "debug", context(lane))).toBeUndefined()
    git(lane, "commit", "-q", "-m", "probe")
    expect(userState()).toEqual(before)
    expect(git(lane, "rev-parse", "refs/heads/debug/x")).not.toBe(before.main)
    git(lane, "checkout", "-q", "--detach")
  }, 60_000)

  test("a commit on a detached HEAD in scratch works and leaves main alone", async () => {
    const before = userState()
    expect(forbiddenGit("git switch --detach", "debug", context(lane))).toBeUndefined()
    git(lane, "switch", "-q", "--detach")
    expect(await headRefusal(lane)).toBeUndefined()
    writeFileSync(join(lane, "c.txt"), "y\n")
    git(lane, "add", "-A")
    git(lane, "commit", "-q", "-m", "detached probe")
    expect(userState()).toEqual(before)
  }, 60_000)
})

describe("bootstrapping off a user branch against real repositories", () => {
  let lane = ""
  const userState = () => ({
    head: git(repo, "rev-parse", "HEAD"),
    main: git(repo, "rev-parse", "refs/heads/main"),
    branch: git(repo, "symbolic-ref", "HEAD"),
    status: git(repo, "status", "--porcelain"),
  })
  /** What the hook does for one shell call: the static verdict, then the HEAD check when it asks for one. */
  const call = async (command: string) => {
    const inspected = inspectGit(command, "debug", context(lane))
    if (inspected.reason !== undefined) return inspected.reason
    return inspected.mutates ? await headRefusal(lane) : undefined
  }
  const forceOntoMain = () => git(lane, "checkout", "-q", "--ignore-other-worktrees", "main")

  beforeAll(() => {
    lane = join(home, ".local/share/opencode/worktree/h1/debug-boot")
    git(repo, "worktree", "add", "-q", "--detach", lane)
    git(repo, "branch", "deadbeef")
  }, 60_000)

  test("names that look like options, hex or reflog entries never count as a detach", async () => {
    const before = userState()
    for (const command of ["git switch -qCmain debug/x", "git switch --cr main", "git checkout -Bmain", "git checkout deadbeef", "git checkout @{-1}", "git switch @{-1}"])
      expect({ command, reason: await call(command) }).toEqual({ command, reason: expect.any(String) })
    expect(userState()).toEqual(before)
  })

  test("a branch change and a commit in one line are refused", async () => {
    expect(await call("git switch -c debug/boot && git commit -am x")).toContain("its own call")
    expect(await call("git add -A; git switch --detach")).toContain("its own call")
  })

  test("starting on main: commit is refused, switch -c debug/x is allowed, and then a separate commit works", async () => {
    const before = userState()
    forceOntoMain()
    expect(await call("git commit -am x")).toContain("refs/heads/main")
    expect(await call("git switch -c debug/boot")).toBeUndefined()
    git(lane, "switch", "-q", "-c", "debug/boot")
    writeFileSync(join(lane, "d.txt"), "z\n")
    git(lane, "add", "-A")
    expect(await call("git commit -am x")).toBeUndefined()
    git(lane, "commit", "-q", "-m", "on debug/boot")
    expect(userState()).toEqual(before)
    git(lane, "checkout", "-q", "--detach")
  }, 60_000)

  test("starting on main: switch --detach is allowed, and a commit after it moves nothing the user owns", async () => {
    const before = userState()
    forceOntoMain()
    expect(await call("git switch --detach")).toBeUndefined()
    git(lane, "switch", "-q", "--detach")
    writeFileSync(join(lane, "e.txt"), "w\n")
    git(lane, "add", "-A")
    expect(await call("git commit -am x")).toBeUndefined()
    git(lane, "commit", "-q", "-m", "detached")
    expect(userState()).toEqual(before)
  }, 60_000)
})
