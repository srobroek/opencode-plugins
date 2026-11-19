import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { headRefusal } from "./head-guard.ts"

// Real git processes are slow on a loaded machine.
setDefaultTimeout(60_000)

let home = ""
let repo = ""

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "modes-head-")))
  repo = join(home, "repo")
  mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "one\n")
  git(repo, "add", "a.txt")
  git(repo, "commit", "-q", "-m", "init")
}, 60_000)
afterAll(() => rmSync(home, { recursive: true, force: true }))

const worktree = (name: string, ...args: string[]) => {
  const path = join(home, name)
  git(repo, "worktree", "add", "-q", ...args, path)
  return path
}

describe("headRefusal", () => {
  test("a debug-* branch, a debug/* branch and a detached HEAD are allowed", async () => {
    expect(await headRefusal(worktree("w1", "-b", "debug-foo"))).toBeUndefined()
    expect(await headRefusal(worktree("w2", "-b", "debug/x"))).toBeUndefined()
    expect(await headRefusal(worktree("w3", "--detach"))).toBeUndefined()
  }, 30_000)

  test("a worktree forced onto the user's branch is refused", async () => {
    const path = worktree("w4", "--detach")
    git(path, "checkout", "--ignore-other-worktrees", "main")
    expect(await headRefusal(path)).toContain("refs/heads/main")
    expect(await headRefusal(repo)).toContain("refs/heads/main")
  }, 30_000)

  test("a branch that only starts with debug is refused", async () => {
    const path = worktree("w5", "-b", "debugger")
    expect(await headRefusal(path)).toContain("refs/heads/debugger")
  }, 30_000)

  test("an unknown workdir and a directory that is not a repository fail closed", async () => {
    expect(await headRefusal(undefined)).toContain("unknown")
    expect(await headRefusal(home)).toContain("could not be read")
    expect(await headRefusal(join(home, "missing"))).toContain("could not be read")
  })

  test("repository config cannot make the check run a command", async () => {
    const marker = join(home, "ran")
    const hook = join(home, "evil.sh")
    writeExecutable(hook, `#!/bin/sh\ntouch ${marker}\n`)
    const path = worktree("w6", "-b", "debug-hostile")
    git(repo, "config", "core.fsmonitor", hook)
    git(repo, "config", "alias.symbolic-ref", `!touch ${marker}`)
    expect(await headRefusal(path)).toBeUndefined()
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  test("the injected runner decides: a non-zero other code is refused", async () => {
    expect(await headRefusal("/x", async () => ({ code: 0, stdout: "refs/heads/debug-a\n" }))).toBeUndefined()
    expect(await headRefusal("/x", async () => ({ code: 1, stdout: "" }))).toBeUndefined()
    expect(await headRefusal("/x", async () => ({ code: 0, stdout: "refs/heads/main\n" }))).toBeString()
    expect(await headRefusal("/x", async () => ({ code: 0, stdout: "" }))).toBeString()
    expect(await headRefusal("/x", async () => Promise.reject(new Error("boom")))).toContain("boom")
  })
})
