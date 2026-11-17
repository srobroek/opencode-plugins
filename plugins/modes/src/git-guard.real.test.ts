import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forbiddenGit } from "./git-guard.ts"

// Real repositories: the user's checkout and a linked debug-* worktree that shares its object store and refs.
let home = ""
let repo = ""
let scratch = ""

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
})
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
  })

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
