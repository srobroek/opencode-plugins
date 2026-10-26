/**
 * Fixture corpus for the permission decisions, ported from the omp rule tests
 * (`srobroek-worktree-destruction-guard.test.ts`, the force-push half of
 * `srobroek-bash-guards.test.ts`, `srobroek-sudo-destructive-advisory.test.ts`).
 *
 * The omp destruction rule fired on every spelling regardless of state. This guard asks
 * unless git proves nothing is lost, so the corpus runs against a real repository and a
 * case that git can prove safe (a landed branch, a clean forced removal, a fast-forward
 * reset) is expected to pass.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhRunner } from "./branch-delete.ts"
import { destructions, FORCE_PUSH_MESSAGE, forcePush, reviewPermission, SUDO_MESSAGE } from "./permission.ts"
import { walkShell } from "./shell.ts"

// Every decision spawns real git processes; a loaded machine can take seconds.
setDefaultTimeout(60_000)

const root = realpathSync(mkdtempSync(join(tmpdir(), "safety-permission-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: ENV })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

const repo = join(root, "repo")
const origin = join(root, "origin.git")
const dirty = join(root, "wt-dirty")
const clean = join(root, "wt-clean")
const loose = join(root, "wt-loose")
Bun.spawnSync(["mkdir", "-p", repo])
git(root, "init", "-q", "-b", "main", repo)
git(repo, "config", "user.email", "t@example.com")
git(repo, "config", "user.name", "t")
writeFileSync(join(repo, "file.txt"), "one\n")
git(repo, "add", "file.txt")
git(repo, "commit", "-q", "-m", "base")
git(repo, "commit", "-q", "--allow-empty", "-m", "second")
git(root, "clone", "-q", "--bare", repo, origin)
git(repo, "remote", "add", "origin", origin)
git(repo, "fetch", "-q", "origin")
git(repo, "remote", "set-head", "origin", "main")
git(repo, "branch", "landed")
git(repo, "checkout", "-q", "-b", "local")
git(repo, "commit", "-q", "--allow-empty", "-m", "local work")
git(repo, "checkout", "-q", "main")
git(repo, "worktree", "add", "-q", "-b", "dirty", dirty)
writeFileSync(join(dirty, "scratch.txt"), "work\n")
git(repo, "worktree", "add", "-q", "-b", "clean", clean)
git(repo, "worktree", "add", "-q", "--detach", loose)
git(loose, "commit", "-q", "--allow-empty", "-m", "loose tip")
writeFileSync(join(repo, "file.txt"), "two\n")
git(repo, "stash", "-q")
git(repo, "remote", "set-url", "origin", "https://gitlab.com/acme/widgets.git")

const gh: GhRunner = async () => "[]"
const review = (command: string, cwd = repo) =>
  reviewPermission(command, cwd, { gh, timeoutMs: 30_000, budgetMs: 120_000 })

type Case = { id: string; command: string; effect?: "ask" | "deny"; why: string }

const MUST_DECIDE: Case[] = [
  {
    id: "wt-remove-force-no-delete-branch",
    command: "wt -y remove --force --no-delete-branch --foreground dirty",
    effect: "ask",
    why: "discards a dirty worktree while keeping the branch",
  },
  {
    id: "wt-remove-force-delete",
    command: "wt -y remove --force --force-delete --foreground local",
    effect: "ask",
    why: "discards the branch tip",
  },
  {
    id: "git-worktree-remove-detached",
    command: `git -C ${repo} worktree remove ${loose}`,
    effect: "deny",
    why: "orphans the detached tip",
  },
  {
    id: "git-worktree-remove-force",
    command: `git worktree remove --force ${dirty}`,
    effect: "ask",
    why: "force removal discards uncommitted changes",
  },
  { id: "git-branch-force-delete", command: `git -C ${repo} branch -D local`, effect: "ask", why: "unmerged tip" },
  { id: "git-branch-delete-long", command: "git branch --delete --force local", effect: "ask", why: "long form" },
  { id: "git-stash-drop", command: `git -C ${repo} stash drop stash@{0}`, effect: "ask", why: "only copy of work" },
  { id: "git-stash-clear", command: "git stash clear", effect: "ask", why: "every entry" },
  { id: "git-reset-hard-back", command: "git reset --hard HEAD~1", effect: "ask", why: "drops a commit from HEAD" },
  {
    id: "chained-after-status",
    command: `git status --short && git worktree remove --force ${dirty}`,
    effect: "ask",
    why: "a later command position",
  },
  { id: "reflog-expire", command: "git reflog expire --expire=now --all", effect: "ask", why: "last recovery path" },
  { id: "git-clean-force", command: "git clean -fd", effect: "ask", why: "deletes untracked files" },
  { id: "nested-stash-clear", command: "bash -c 'git stash clear'", effect: "ask", why: "a shell opener runs it" },
  {
    id: "force push",
    command: "git push --force origin main",
    effect: "deny",
    why: "the shape the guard exists for",
  },
  { id: "force push cluster", command: "git push -uf origin main", effect: "deny", why: "bundled short flags" },
  {
    id: "force push with other long flags",
    command: "git push --follow-tags --force origin main",
    effect: "deny",
    why: "combined flags",
  },
  {
    id: "force option after end-of-options",
    command: "git push -- --force origin main",
    effect: "deny",
    why: "the whole push argument is read",
  },
  {
    id: "force push on a script line",
    command: "cd /work/repo\ngit push -f origin main",
    effect: "deny",
    why: "a verb starting a line",
  },
  {
    id: "force push after a separator",
    command: "echo ok && git push --force origin main",
    effect: "deny",
    why: "chained",
  },
  { id: "force refspec", command: "git push origin +main", effect: "deny", why: "a `+` refspec forces" },
  { id: "sudo rm", command: "sudo rm -rf /var/tmp/cache", effect: "ask", why: "elevated destruction" },
  { id: "sudo chmod -R", command: "echo ok && sudo chmod -R 777 /srv/app", effect: "ask", why: "recursive" },
]

const MUST_PASS: Case[] = [
  {
    id: "wt-switch-create",
    command: "wt switch -y --create --no-cd --base origin/main --format json omp/agent/x",
    why: "creating destroys nothing",
  },
  { id: "worktree-list", command: `git -C ${repo} worktree list`, why: "read-only" },
  { id: "worktree-prune", command: `git -C ${repo} worktree prune`, why: "metadata of gone directories" },
  { id: "branch-list", command: "git branch --list 'omp/agent/*'", why: "--list is not a delete" },
  { id: "branch-create", command: `git -C ${repo} branch omp/agent/x main`, why: "the recovery" },
  { id: "stash-apply", command: `git -C ${repo} stash apply stash@{0}`, why: "keeps the entry" },
  { id: "stash-list", command: "git stash list", why: "read-only" },
  { id: "wt-step-prune", command: "wt step prune", why: "merged-only cleanup" },
  { id: "wt-step-prune-dry-run", command: "wt step prune --dry-run", why: "preview" },
  { id: "wt-step-prune-min-age", command: `wt -y -C ${repo} step prune --min-age 7d`, why: "global flags" },
  { id: "wt-remove-merged-no-force", command: "wt remove -y clean", why: "wt refuses a dirty tree itself" },
  { id: "wt-remove-no-delete-branch", command: "wt remove --no-delete-branch clean", why: "safest form" },
  {
    id: "git-worktree-remove-unforced",
    command: `git worktree remove ${dirty}`,
    why: "git refuses a dirty checkout without --force",
  },
  { id: "forced-removal-clean", command: `git worktree remove --force ${clean}`, why: "nothing to discard" },
  { id: "landed-branch-delete", command: "git branch -D landed", why: "an ancestor of origin/main" },
  {
    id: "reset-hard-untracked-only",
    command: `git -C ${dirty} reset --hard`,
    why: "untracked files survive a hard reset, so a clean tracked tree is safe",
  },
  { id: "reset-soft", command: "git reset --soft HEAD~1", why: "keeps the tree" },
  { id: "reset-hard-noop", command: `git -C ${clean} reset --hard`, why: "clean tree, same commit" },
  {
    id: "reset-hard-fast-forward",
    command: `git -C ${clean} reset --hard origin/main`,
    why: "HEAD is an ancestor of the target",
  },
  { id: "restore-file", command: "git checkout -- file.txt", why: "routine" },
  { id: "clean-dry-run", command: "git clean -fdn", why: "preview" },
  { id: "remove-in-prose", command: "rg --fixed-strings 'worktree remove' docs/", why: "searching" },
  { id: "stash-clear-echoed", command: "echo 'git stash clear'", why: "data" },
  { id: "force push in a commit message", command: 'git commit -m "guard git push --force"', why: "data" },
  { id: "force push in a grep", command: 'grep -n "git push --force" test/rules.test.ts', why: "data" },
  { id: "force with lease", command: "git push --force-with-lease origin main", why: "the safe form" },
  { id: "force with lease refspec", command: "git push --force-with-lease=origin/main", why: "the safe form" },
  { id: "force if includes", command: "git push --force-if-includes origin main", why: "the other safe form" },
  {
    id: "force push string in a test",
    command: "bun -e 'const deny = \"git status && git push --force origin main\"; console.log(deny.length)'",
    why: "data",
  },
  { id: "plain push", command: "git push -u origin feat/x", why: "not forced" },
  { id: "sudo echoed", command: 'echo "sudo rm -rf /"', why: "data" },
  { id: "sudo in a description", command: 'bd create --description "never sudo rm files"', why: "data" },
  { id: "sudo id", command: "sudo -u builder id", why: "not destructive" },
  { id: "rm without sudo", command: "rm -rf ./dist", why: "the user's own tree" },
]

describe("decides", () => {
  for (const c of MUST_DECIDE) {
    test(`${c.effect}: ${c.id}`, async () => {
      expect((await review(c.command))?.effect).toBe(c.effect as "ask" | "deny")
    })
  }
})

describe("passes", () => {
  for (const c of MUST_PASS) {
    test(c.id, async () => {
      expect(await review(c.command)).toBeUndefined()
    })
  }
})

describe("messages", () => {
  test("a force push names the lease", async () => {
    expect(await review("git push -f")).toEqual({ effect: "deny", message: FORCE_PUSH_MESSAGE })
    expect(FORCE_PUSH_MESSAGE).toContain("--force-with-lease")
  })

  test("sudo destruction asks with its own text", async () => {
    expect(await review("sudo rm -rf /var/tmp/x")).toEqual({ effect: "ask", message: SUDO_MESSAGE })
  })

  test("a stash drop names the entry and its restore", async () => {
    const sha = git(repo, "rev-parse", "stash@{0}")
    const decision = await review("git stash drop")
    expect(decision?.message).toContain(`stash@{0} is ${sha}`)
    expect(decision?.message).toContain(`git stash store -m restored ${sha}`)
  })

  test("a hard reset names what it discards and how to undo it", async () => {
    const head = git(repo, "rev-parse", "HEAD")
    const decision = await review("git reset --hard HEAD~1")
    expect(decision?.message).toContain("1 commit(s) on HEAD are not in HEAD~1")
    expect(decision?.message).toContain(`Restore: git reset --hard ${head}`)
  })

  test("an unlanded branch delete carries the branch gate's evidence", async () => {
    const decision = await review("git branch -D local")
    expect(decision?.message).toContain("Force-delete local? Its work is not proven landed.")
    expect(decision?.message).toContain("Restore: git branch local")
  })

  test("a delete the branch gate cannot attribute asks instead of denying", async () => {
    expect((await review('git commit -m "docs: clean up with git branch -D"'))?.effect).toBe("ask")
  })

  test("a delete of a branch that does not exist is denied", async () => {
    expect((await review("git branch -D ghost"))?.effect).toBe("deny")
  })

  test("asks combine into one message", async () => {
    const decision = await review("sudo rm -rf /var/tmp/x; git stash clear")
    expect(decision?.effect).toBe("ask")
    expect(decision?.message).toContain("sudo-destructive")
    expect(decision?.message).toContain("worktree-destruction-guard")
  })

  test("disabled decisions are skipped", async () => {
    expect(await reviewPermission("git push -f", repo, { disabled: new Set(["force-push"]) })).toBeUndefined()
  })
})

describe("parsing", () => {
  test("force push reads git's global options", () => {
    const [command] = walkShell("git -C /r -c push.default=current push --force").commands
    expect(command && forcePush(command)).toBe(true)
  })

  test("a reset target that expands has no directory to probe", () => {
    const found = destructions(walkShell('git reset --hard "$REF"').commands, "/r")
    expect(found[0]).toMatchObject({ kind: "reset-hard", dir: undefined })
  })

  test("a later cd makes the directory unknowable", async () => {
    expect((await review(`git status; cd ${clean}; git reset --hard`))?.message).toContain("cannot be read with certainty")
    expect(await review(`cd ${clean} && git reset --hard`, "/")).toBeUndefined()
  })
})
