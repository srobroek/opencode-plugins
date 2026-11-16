/**
 * The history-rewrite guard. A "canonical" checkout is a directory with a `.git` directory that
 * is not under a temp root; the tests pick a temp root that excludes their own scratch folders.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { leadingCdCwd } from "@srobroek/opencode-lib"
import { hardGate } from "./guards.ts"

let root: string
let canonical: string
let linked: string
let elsewhere: string
/** A temp root that holds none of the test folders, so they count as ordinary checkouts. */
const NO_TEMP = ["/nonexistent-temp-root"]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "history-rewrite-")))
  canonical = join(root, "main-checkout")
  mkdirSync(join(canonical, ".git"), { recursive: true })
  mkdirSync(join(canonical, "sub"), { recursive: true })
  linked = join(root, "linked")
  mkdirSync(linked, { recursive: true })
  writeFileSync(join(linked, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n")
  elsewhere = join(root, "plain")
  mkdirSync(elsewhere, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = (command: string, cwd: string, tempRoots: readonly string[] = NO_TEMP) => hardGate(command, cwd, { tempRoots })

describe("history rewrites in a canonical checkout", () => {
  test.each([
    "git filter-repo --subdirectory-filter X",
    "git-filter-repo --subdirectory-filter X",
    "uvx git-filter-repo --source /x --subdirectory-filter X",
    "uvx --from git-filter-repo git-filter-repo --path a",
    "pipx run git-filter-repo --path a",
    "uv tool run git-filter-repo --path a",
    "python3 -m git_filter_repo --path a",
    "env FOO=1 git filter-repo --path a",
    "sudo git filter-repo --path a",
    "git filter-branch --env-filter true",
    "git replace abc123 def456",
    "git replace --graft abc123",
    "git update-ref -d refs/heads/main",
    "git update-ref -d refs/heads/main abc123",
    "git update-ref refs/heads/main 0000000000000000000000000000000000000000",
    "git update-ref -m msg --no-deref -d refs/heads/feature",
  ])("refuses %s", (command) => {
    const refusal = run(command, canonical)
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("canonical checkout")
    expect(refusal?.reason).toContain("temp")
    expect(refusal?.reason).toContain("workdir")
  })

  test("names what was refused and where", () => {
    const refusal = run("git filter-branch --env-filter true", canonical)
    expect(refusal?.reason).toContain("`git filter-branch`")
    expect(refusal?.reason).toContain(canonical)
  })

  test("a subdirectory of the checkout is still the checkout", () => {
    expect(run("git filter-repo --path a", join(canonical, "sub"))?.guard).toBe("history-rewrite")
  })

  test("a literal cd into the checkout, and git -C into it, are read", () => {
    // The plugin hands the gate the directory after a leading literal `cd`.
    const cd = `cd ${canonical} && git filter-repo --path a`
    expect(run(cd, leadingCdCwd(cd, elsewhere))?.guard).toBe("history-rewrite")
    expect(run(`git -C ${canonical} filter-branch --env-filter true`, elsewhere)?.guard).toBe("history-rewrite")
    expect(run("git -C main-checkout replace a b", root)?.guard).toBe("history-rewrite")
  })

  test("filter-repo --target decides where it writes, not the working directory", () => {
    expect(run(`git filter-repo --target ${canonical} --path a`, elsewhere)?.guard).toBe("history-rewrite")
    expect(run(`git filter-repo --target=${linked} --path a`, canonical)).toBeUndefined()
    expect(run(`uvx git-filter-repo --source ${canonical} --target ${elsewhere} --path a`, canonical)).toBeUndefined()
  })
})

describe("history rewrites that are allowed", () => {
  test.each([
    "git filter-repo --path a",
    "uvx git-filter-repo --path a",
    "git filter-branch --env-filter true",
    "git replace a b",
    "git update-ref -d refs/heads/main",
  ])("allows %s in a linked worktree", (command) => {
    expect(run(command, linked)).toBeUndefined()
  })

  test.each(["git filter-repo --path a", "git filter-branch --env-filter true", "git update-ref -d refs/heads/main"])(
    "allows %s in a temp clone",
    (command) => {
      // The scratch folders sit under the OS temp directory, so with the default temp roots they are temp clones.
      expect(hardGate(command, canonical)).toBeUndefined()
    },
  )

  test("allows a directory that is not a git repository", () => {
    expect(run("git filter-repo --path a", elsewhere)).toBeUndefined()
  })

  test.each([
    "git update-ref refs/heads/main abc123",
    "git update-ref -d refs/tags/v1",
    "git update-ref -d refs/remotes/origin/x",
    "git replace --list",
    "git replace -l",
    "git status",
    "git log --oneline",
    "git commit -m 'filter-repo --force'",
    "git rebase -i HEAD~3",
    "echo git filter-repo --path a",
    'grep -r "git filter-branch" docs',
    "git branch -d old",
  ])("leaves %s alone in a canonical checkout", (command) => {
    expect(run(command, canonical)).toBeUndefined()
  })
})

describe("filter-repo --force", () => {
  test.each([
    "git filter-repo --force --path a",
    "git filter-repo --path a --force",
    "git-filter-repo -f --path a",
    "uvx git-filter-repo --source /x --subdirectory-filter X --force",
    "pipx run git-filter-repo --force",
  ])("refuses %s everywhere", (command) => {
    for (const cwd of [canonical, linked, elsewhere]) {
      expect(run(command, cwd)?.reason).toContain("--force")
      expect(hardGate(command, cwd)?.guard).toBe("history-rewrite")
    }
  })
})

describe("the guard can be switched off", () => {
  test("disabled", () => {
    expect(hardGate("git filter-repo --path a", canonical, { tempRoots: NO_TEMP, disabled: new Set(["history-rewrite"]) })).toBeUndefined()
  })
})
