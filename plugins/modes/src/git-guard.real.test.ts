import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forbiddenGit } from "./git-guard.ts"

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
