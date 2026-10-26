import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  deleteRequests,
  type GateOptions,
  type GhRunner,
  githubRepo,
  mentionsForceDelete,
  reviewBranchDeletes,
  type Verdict,
  validBranchName,
} from "./branch-delete.ts"

// Every decision spawns real git processes; a loaded machine can take seconds.
setDefaultTimeout(60_000)

// Generous bounds: the gate's own timeouts are under test in branch-delete.timeout.test.ts.
const review = (command: string, cwd: string, options: GateOptions = {}) =>
  reviewBranchDeletes(command, cwd, { timeoutMs: 30_000, budgetMs: 120_000, ...options })

// The gate classifies git state, so every decision is proved against real repositories. Nothing is
// deleted: the gate only computes its verdict for a command that is never run.
const root = realpathSync(mkdtempSync(join(tmpdir(), "branch-delete-gate-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: ENV })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}
function commit(cwd: string, subject: string): void {
  git(cwd, "commit", "-q", "--allow-empty", "-m", subject)
}

const repo = join(root, "repo")
const origin = join(root, "origin.git")
const elsewhere = join(root, "elsewhere")
const worktree = join(root, "wt-wip")
const detached = join(root, "wt-detached")

Bun.spawnSync(["mkdir", "-p", repo])
git(root, "init", "-q", "-b", "main", repo)
git(repo, "config", "user.email", "t@example.com")
git(repo, "config", "user.name", "t")
commit(repo, "base")
git(root, "clone", "-q", "--bare", repo, origin)
git(repo, "remote", "add", "origin", origin)
git(repo, "fetch", "-q", "origin")
git(repo, "branch", "-q", "-u", "origin/main", "main")
git(repo, "remote", "set-head", "origin", "main")
// landed: fast-forwarded into main, so its tip is an ancestor of origin/main.
git(repo, "checkout", "-q", "-b", "landed")
commit(repo, "landed work")
git(repo, "checkout", "-q", "main")
git(repo, "merge", "-q", "--ff-only", "landed")
// squashed: pushed, then landed on main as a different (squash) commit.
git(repo, "checkout", "-q", "-b", "squashed")
commit(repo, "squash me")
git(repo, "push", "-q", "-u", "origin", "squashed")
git(repo, "checkout", "-q", "main")
commit(repo, "squash me (#41)")
git(repo, "push", "-q", "origin", "main")
// pushed: on the remote, never merged.
git(repo, "checkout", "-q", "-b", "pushed")
commit(repo, "pushed work")
git(repo, "push", "-q", "-u", "origin", "pushed")
// local: exists nowhere else.
git(repo, "checkout", "-q", "-b", "local", "main")
commit(repo, "local one")
commit(repo, "local two")
git(repo, "checkout", "-q", "main")
// A worktree on its own unlanded branch, and a detached one.
git(repo, "worktree", "add", "-q", "-b", "wip", worktree, "main")
commit(worktree, "wip work")
git(repo, "worktree", "add", "-q", "--detach", detached, "main")
// A clone whose remote is not on GitHub.
git(root, "clone", "-q", origin, elsewhere)
git(elsewhere, "config", "user.email", "t@example.com")
git(elsewhere, "config", "user.name", "t")
git(elsewhere, "checkout", "-q", "-b", "solo")
commit(elsewhere, "solo work")
git(elsewhere, "remote", "set-url", "origin", "https://gitlab.com/acme/widgets.git")
// From here on no git call reaches a network: only local refs are read, and gh is injected.
git(repo, "remote", "set-url", "origin", "https://github.com/acme/widgets.git")

const tip = (name: string, cwd = repo) => git(cwd, "rev-parse", `refs/heads/${name}`)

type Pr = { number: number; headRefOid: string; headRefName: string }
function fakeGh(prs: Record<string, Pr[] | null> = {}) {
  const calls: string[][] = []
  const runner: GhRunner = async (args) => {
    calls.push(args)
    const head = args[args.indexOf("--head") + 1] as string
    const answer = prs[head]
    return answer === null ? null : JSON.stringify(answer ?? [])
  }
  return { calls, runner }
}

function confirm(verdict: Verdict): Extract<Verdict, { action: "confirm" }> {
  if (verdict.action !== "confirm") throw new Error(`expected confirm, got ${JSON.stringify(verdict)}`)
  return verdict
}
function refusal(verdict: Verdict): string {
  if (verdict.action !== "refuse") throw new Error(`expected refuse, got ${JSON.stringify(verdict)}`)
  return verdict.reason
}

describe("landed branches pass silently", () => {
  test("a tip in the default branch is allowed without asking GitHub", async () => {
    const gh = fakeGh()
    expect(await review("git branch -D landed", repo, { gh: gh.runner })).toEqual({ action: "allow" })
    expect(gh.calls).toEqual([])
  })

  test("a squash-merged branch is allowed when GitHub reports its merged PR at this exact tip", async () => {
    const gh = fakeGh({ squashed: [{ number: 41, headRefOid: tip("squashed"), headRefName: "squashed" }] })
    expect(await review("git branch --delete --force squashed", repo, { gh: gh.runner })).toEqual({ action: "allow" })
    expect(gh.calls).toEqual([
      ["pr", "list", "--repo", "acme/widgets", "--state", "merged", "--head", "squashed", "--json", "number,headRefOid,headRefName"],
    ])
  })

  test("every force spelling of a landed delete is allowed", async () => {
    for (const command of ["git branch -d -f landed", "git branch -df landed", "git branch --delete -f landed", "git branch -D -- landed"]) {
      expect(await review(command, repo, { gh: fakeGh().runner })).toEqual({ action: "allow" })
    }
  })
})

describe("unlanded branches ask the owner", () => {
  test("a merged PR whose head is another commit proves nothing", async () => {
    const gh = fakeGh({ squashed: [{ number: 41, headRefOid: "0".repeat(40), headRefName: "squashed" }] })
    const verdict = confirm(await review("git branch -D squashed", repo, { gh: gh.runner }))
    expect(verdict.message).toContain("no merged pull request on acme/widgets has head squashed at this tip")
  })

  test("a tip held by a remote ref is recoverable, but its work is not in main", async () => {
    const verdict = confirm(await review("git branch -D pushed", repo, { gh: fakeGh().runner }))
    expect(verdict.title).toBe("Force-delete pushed? Its work is not proven landed.")
    expect(verdict.branches).toEqual(["pushed"])
    expect(verdict.message).toContain(`Tip: ${tip("pushed")}`)
    expect(verdict.message).toContain("1 commit not in origin/main:")
    expect(verdict.message).toMatch(/[0-9a-f]{7,} pushed work/)
    expect(verdict.message).toContain("origin/pushed holds this tip, but it is not merged into origin/main")
    expect(verdict.message).toContain(`Restore: git branch pushed ${tip("pushed")}`)
  })

  test("a tip that exists nowhere else says the commits would be lost", async () => {
    const verdict = confirm(await review("git branch -D local", repo, { gh: fakeGh().runner }))
    expect(verdict.message).toContain("2 commits not in origin/main:")
    expect(verdict.message).toContain("local two")
    expect(verdict.message).toContain("local one")
    expect(verdict.message).toContain("These commits exist nowhere else and would be lost.")
    expect(verdict.message).toContain(`Restore: git branch local ${tip("local")}`)
  })

  test("mixed safe and unsafe names ask once, listing only the unsafe ones", async () => {
    const gh = fakeGh({ squashed: [{ number: 41, headRefOid: tip("squashed"), headRefName: "squashed" }] })
    const verdict = confirm(await review("git branch -D landed pushed local squashed", repo, { gh: gh.runner }))
    expect(verdict.branches).toEqual(["pushed", "local"])
    expect(verdict.title).toBe("Force-delete 2 branches? Their work is not proven landed.")
    expect(verdict.message).toContain("Branch pushed in")
    expect(verdict.message).toContain("Branch local in")
    expect(verdict.message).not.toContain("Branch landed in")
    expect(verdict.message).toContain("Landed, deleted without asking: landed (ancestor of origin/main), squashed (merged PR #41)")
  })

  test("a failed gh (not installed, not authenticated) is absence, never proof", async () => {
    const gh = fakeGh({ squashed: null })
    const verdict = confirm(await review("git branch -D squashed", repo, { gh: gh.runner }))
    expect(verdict.message).toContain("gh could not answer for acme/widgets")
  })

  test("a remote outside GitHub skips the PR lookup", async () => {
    const gh = fakeGh()
    const verdict = confirm(await review("git branch -D solo", elsewhere, { gh: gh.runner }))
    expect(gh.calls).toEqual([])
    expect(verdict.message).toContain("skipped: remote origin is not on GitHub.")
    expect(verdict.message).toContain("These commits exist nowhere else and would be lost.")
  })

  test("a branch an earlier command can move is asked about even when it looks landed", async () => {
    const gh = fakeGh()
    const verdict = confirm(await review("git commit --allow-empty -m wip && git switch main && git branch -D landed", repo, { gh: gh.runner }))
    expect(verdict.message).toContain("Unverified: an earlier command in this call can move the branch")
    expect(gh.calls).toEqual([])
    for (const command of ["git fetch origin main:landed && git branch -D landed", "npm run release && wt remove -D wip"]) {
      expect(confirm(await review(command, repo, { gh: gh.runner })).message).toContain("Unverified")
    }
  })

  test("commands that cannot move a branch keep a landed delete silent", async () => {
    for (const command of [
      "git switch main && git branch -D landed",
      "git fetch --prune && git pull --ff-only && git branch -D landed",
      "git fetch --prune && git checkout main && git pull && git branch -D landed",
      "git status; echo cleaning && git branch -D landed 2>&1",
      "git branch -D landed >/dev/null 2>&1 && echo ok",
    ]) {
      expect(await review(command, repo, { gh: fakeGh().runner })).toEqual({ action: "allow" })
    }
  })

  test("a here-document body that runs a delete is classified, not dropped as data", async () => {
    const verdict = confirm(await review("bash <<'EOF'\ngit branch -D local\nEOF", repo, { gh: fakeGh().runner }))
    expect(verdict.branches).toEqual(["local"])
  })
})

describe("directories", () => {
  test("-C resolves the repository relative to the call's directory", async () => {
    expect(await review(`git -C ${repo} branch -D landed`, "/", { gh: fakeGh().runner })).toEqual({ action: "allow" })
    expect(confirm(await review("git -C repo branch -D local", root, { gh: fakeGh().runner })).branches).toEqual(["local"])
  })

  test("a cd chained with && sets the directory; one the delete cannot rely on refuses", async () => {
    expect(await review(`cd ${repo} && git branch -D landed`, "/", { gh: fakeGh().runner })).toEqual({ action: "allow" })
    expect(refusal(await review(`cd ${repo}; git branch -D landed`, "/"))).toContain("cannot be determined")
    expect(refusal(await review(`false || cd ${repo} && git branch -D landed`, "/"))).toContain("cannot be determined")
  })

  test("the currently checked-out branch is classified like any other", async () => {
    expect(git(repo, "branch", "--show-current")).toBe("main")
    expect(await review("git branch -D main", repo, { gh: fakeGh().runner })).toEqual({ action: "allow" })
  })
})

describe("wt remove -D", () => {
  test("resolves the current worktree's branch", async () => {
    expect(confirm(await review("wt remove -D", worktree, { gh: fakeGh().runner })).branches).toEqual(["wip"])
  })

  test("resolves a branch name or a worktree path", async () => {
    expect(confirm(await review("wt remove --force-delete wip", repo, { gh: fakeGh().runner })).branches).toEqual(["wip"])
    expect(confirm(await review(`wt -C ${repo} remove -yD ../wt-wip`, repo, { gh: fakeGh().runner })).branches).toEqual(["wip"])
  })

  test("a detached worktree has no branch to delete", async () => {
    expect(await review("wt remove -D", detached, { gh: fakeGh().runner })).toEqual({ action: "allow" })
    expect(await review(`wt remove -D ${detached}`, repo, { gh: fakeGh().runner })).toEqual({ action: "allow" })
  })

  test("removals that delete no unmerged branch are left to wt", async () => {
    expect(await review("wt remove wip", repo)).toEqual({ action: "allow" })
    expect(await review("wt remove --no-delete-branch -D wip", repo)).toEqual({ action: "allow" })
  })

  test("a target that names nothing is refused", async () => {
    expect(refusal(await review("wt remove -D ghost", repo))).toContain("names no branch or worktree")
  })
})

describe("refusals", () => {
  test("a missing branch cannot be resolved", async () => {
    expect(refusal(await review("git branch -D ghost", repo))).toContain("branch ghost does not exist")
  })

  test("wrapped deletes are refused before any probe", async () => {
    for (const command of [
      "bash -c 'git branch -D local'",
      "echo local | xargs git branch -D",
      "timeout 5 git branch -D local",
      "sudo -u me git branch -D local",
      "git --git-dir=/elsewhere branch -D local",
      "python3 -c \"import os; os.system('git branch -D local')\"",
      "echo 'git branch -D local'",
      'git commit -m "docs: clean up with git branch -D"',
    ]) {
      expect(refusal(await review(command, "/nonexistent"))).toContain("cannot attribute")
    }
  })

  test("expanded or unbalanced targets are refused", async () => {
    for (const command of [
      'git branch -D "$BRANCH"',
      "git branch -D $(git branch --format=x)",
      "git branch -D feat-{a,b}",
      "git branch -D feat*",
      "git branch -D \\\nlocal",
      "for b in a c; do git branch -D \"$b\"; done",
    ]) {
      expect(refusal(await review(command, "/nonexistent"))).toContain("Name each branch literally")
    }
    expect(refusal(await review("git branch -D 'local", "/nonexistent"))).toContain("quotes do not balance")
  })

  test("repository overrides and remote-tracking deletes are refused", async () => {
    expect(refusal(await review("GIT_DIR=/x git branch -D local", "/nonexistent"))).toContain("GIT_*")
    expect(refusal(await review("git branch -D -r origin/pushed", repo))).toContain("remote-tracking")
    expect(refusal(await review("git branch -D 'a b'", repo))).toContain("not a local branch name")
  })

  test("a directory that is not a repository is refused", async () => {
    expect(refusal(await review("git branch -D local", root))).toContain("not inside a git repository")
  })
})

describe("untouched commands", () => {
  test("non-force deletes and unrelated commands are allowed without probing", async () => {
    for (const command of ["git branch -d local", "git branch --list", "echo hello", "git log -D", "wt list"]) {
      expect(await review(command, "/nonexistent")).toEqual({ action: "allow" })
    }
  })
})

describe("parsing", () => {
  test("reads directories and targets of each spelling", () => {
    expect(deleteRequests("git -C a -C b branch -D x y", "/r")).toEqual([
      { tool: "git", dir: "/r/a/b", targets: ["x", "y"], unverified: false, text: "git -C a -C b branch -D x y" },
    ])
    expect(deleteRequests("cd /r && wt -C sub remove -D t", "/")).toEqual([
      { tool: "wt", dir: "/r/sub", targets: ["t"], unverified: false, text: "wt -C sub remove -D t" },
    ])
  })

  test("the mention test is a superset of every accepted spelling", async () => {
    for (const command of ["git branch -D x", "git 'branch' '-D' x", "git br''anch -D x", "git branch -fd x", "git branch --del --forc x", "wt remove --force-delete x", "/usr/bin/wt rm -yD"]) {
      expect(mentionsForceDelete(command)).toBe(true)
    }
    for (const command of ["git branch -d x", "git switch -c feature-branch", "wt remove x", "git log --format=%D"]) {
      expect(mentionsForceDelete(command)).toBe(false)
    }
  })

  test("the prefilter stays linear on long commands", async () => {
    const started = performance.now()
    expect(mentionsForceDelete(`${"wt ".repeat(20_000)}-D`)).toBe(false)
    expect(mentionsForceDelete(`echo ${"x/".repeat(30_000)} branch ${"-a ".repeat(10_000)}`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("GitHub remotes resolve to owner/repo and others to nothing", async () => {
    expect(githubRepo("https://github.com/acme/widgets.git")).toBe("acme/widgets")
    expect(githubRepo("git@github.com:acme/widgets.git")).toBe("acme/widgets")
    expect(githubRepo("ssh://git@ssh.github.com:443/acme/widgets")).toBe("acme/widgets")
    expect(githubRepo("https://gitlab.com/acme/widgets.git")).toBeNull()
    expect(githubRepo("/srv/git/widgets.git")).toBeNull()
  })

  test("branch names follow git's ref format", async () => {
    expect(validBranchName("feat/x-1")).toBe(true)
    for (const name of ["-x", "a..b", "a b", "x.lock", "@", "a@{1}", "a/", ".a", "a~1"]) expect(validBranchName(name)).toBe(false)
  })
})
