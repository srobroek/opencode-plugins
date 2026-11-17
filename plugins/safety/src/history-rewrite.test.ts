/**
 * The history-rewrite guard fails closed: a rewriting command passes only when its directory
 * resolves unambiguously to a linked worktree or a temp clone, by the logical rule (shell `cd`)
 * and the physical rule (symlinks resolved per component).
 *
 * Layout (tempRoots = [temp], so only `temp/clone` is a temp clone):
 *   canonical/.git/        canonical checkout       canonical/to-linked -> ../linked
 *   canonical/sub/                                  canonical/to-clone  -> ../temp/clone
 *   linked/.git (file)     linked worktree
 *   temp/clone/.git/       temp clone               temp/clone/to-canonical -> ../../canonical/sub
 *   plain/                 not a repository         plain/link -> ../canonical/sub
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hardGate } from "./guards.ts"

let root: string
let where: Record<string, string>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "history-rewrite-")))
  const dir = (...parts: string[]) => {
    mkdirSync(join(root, ...parts), { recursive: true })
    return join(root, ...parts)
  }
  dir("canonical", ".git")
  dir("canonical", "sub")
  dir("linked", "sub")
  writeFileSync(join(root, "linked", ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n")
  dir("temp", "clone", ".git")
  dir("temp", "clone", "sub")
  dir("plain")
  symlinkSync(join(root, "linked"), join(root, "canonical", "to-linked"))
  symlinkSync(join(root, "temp", "clone"), join(root, "canonical", "to-clone"))
  symlinkSync(join(root, "canonical", "sub"), join(root, "temp", "clone", "to-canonical"))
  symlinkSync(join(root, "canonical", "sub"), join(root, "plain", "link"))
  where = {
    canonical: join(root, "canonical"),
    "canonical/sub": join(root, "canonical", "sub"),
    linked: join(root, "linked"),
    "linked/sub": join(root, "linked", "sub"),
    clone: join(root, "temp", "clone"),
    "clone/sub": join(root, "temp", "clone", "sub"),
    plain: join(root, "plain"),
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Substitute `{name}` with the absolute path of a layout directory. */
const fill = (command: string): string => command.replace(/\{([\w/-]+)\}/g, (_, name: string) => where[name] ?? name)
const run = (command: string, cwd: string) =>
  hardGate(fill(command), where[cwd] as string, { tempRoots: [join(root, "temp")] })

const R = "git filter-branch --env-filter true"
const ZERO = "0".repeat(40)

type Case = [name: string, command: string, cwd: string]

describe("a rewrite passes only where it provably runs in a linked worktree or temp clone", () => {
  const allowed: Case[] = [
    ["in a linked worktree", R, "linked"],
    ["in a linked worktree subdirectory", R, "linked/sub"],
    ["in a temp clone", R, "clone"],
    ["in a temp clone subdirectory", R, "clone/sub"],
    ["outside any repository", R, "plain"],
    ["filter-repo in a linked worktree", "git filter-repo --path a", "linked"],
    ["uvx filter-repo in a temp clone", "uvx git-filter-repo@2.47.0 --path a", "clone"],
    ["replace in a temp clone", "git replace a b", "clone"],
    ["a branch delete in a linked worktree", "git update-ref -d refs/heads/main", "linked"],
    ["-C into a linked worktree", `git -C {linked} ${R.slice(4)}`, "canonical"],
    ["-C into a temp clone", `git -C {clone} ${R.slice(4)}`, "canonical"],
    ["a relative -C into a linked worktree", `git -C ../linked ${R.slice(4)}`, "canonical"],
    ["an unquoted cd into a linked worktree", `cd {linked} && ${R}`, "canonical"],
    ["a quoted cd into a linked worktree", `cd "{linked}" && ${R}`, "canonical"],
    ["a single-quoted cd into a temp clone", `cd '{clone}' && ${R}`, "canonical"],
    ["a relative cd into a linked worktree subdirectory", `cd ../../linked/sub && ${R}`, "canonical/sub"],
    ["cd through a symlink that agrees both ways", `cd to-linked && ${R}`, "canonical"],
    ["--target into a linked worktree", "git filter-repo --target {linked} --path a", "canonical"],
    ["a subshell cd that does not reach it", `(cd {canonical}); ${R}`, "linked"],
    ["a pipeline cd that does not reach it", `cd {canonical} | cat; ${R}`, "linked"],
    ["a background cd that does not reach it", `cd {canonical} & ${R}`, "linked"],
    ["a separate script's cd", `bash -c 'cd {canonical}'; ${R}`, "linked"],
    ["a substitution's cd", `echo $(cd {canonical}); ${R}`, "linked"],
    ["a literal transaction deleting a branch, in a linked worktree", `git update-ref --stdin <<< 'delete refs/heads/main'`, "linked"],
  ]
  test.each(allowed)("allows %s", (_name, command, cwd) => {
    expect(run(command, cwd)).toBeUndefined()
  })

  const refused: Case[] = [
    ["in a canonical checkout", R, "canonical"],
    ["in a canonical subdirectory", R, "canonical/sub"],
    ["filter-repo in a canonical checkout", "git filter-repo --path a", "canonical"],
    ["git-filter-repo in a canonical checkout", "git-filter-repo --path a", "canonical"],
    ["replace in a canonical checkout", "git replace a b", "canonical"],
    ["a branch delete in a canonical checkout", "git update-ref -d refs/heads/main", "canonical"],
    ["a zero-OID update", `git update-ref refs/heads/main ${ZERO}`, "canonical"],
    ["an empty new value", 'git update-ref refs/heads/main ""', "canonical"],
    ["deleting HEAD's branch", "git update-ref -d HEAD", "canonical"],
    ["-C into a canonical checkout", `git -C {canonical} ${R.slice(4)}`, "linked"],
    ["cd into a canonical checkout", `cd {canonical} && ${R}`, "linked"],
    ["a quoted cd into a canonical checkout", `cd "{canonical}" && ${R}`, "linked"],
    ["--target into a canonical checkout", "git filter-repo --target {canonical} --path a", "linked"],
    ["a subshell cd that does not reach it", `(cd {linked}); ${R}`, "canonical"],
    ["a pipeline cd that does not reach it", `cd {linked} | cat; ${R}`, "canonical"],
    ["a background cd that does not reach it", `cd {linked} & ${R}`, "canonical"],
    ["a script's cd that does not reach it", `bash -c 'cd {linked}'; ${R}`, "canonical"],
  ]
  test.each(refused)("refuses %s", (_name, command, cwd) => {
    const refusal = run(command, cwd)
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("temp")
    expect(refusal?.reason).toContain("workdir")
  })
})

describe("anything the guard cannot settle is refused", () => {
  const uncertain: Case[] = [
    // The shell's logical `..` and the physical `..` through a symlink disagree.
    ["cd link/.. from a canonical checkout (stays in canonical)", `cd "to-linked/.." && ${R}`, "canonical"],
    ["cd link/.. unquoted", `cd to-linked/.. && ${R}`, "canonical"],
    ["cd link/.. from a temp clone (logical stays in the clone)", `cd "to-canonical/.." && ${R}`, "clone"],
    ["cd link/.. from a linked worktree", `cd {canonical}/to-linked/.. && ${R}`, "linked"],
    ["-C link/..", `git -C link/.. ${R.slice(4)}`, "plain"],
    ["chained -C link then ..", `git -C link -C .. ${R.slice(4)}`, "plain"],
    ["--target link/..", "git filter-repo --target link/.. --path a", "plain"],
    ["a quoted cd -P through a link", `cd -P "to-linked/.." && ${R}`, "canonical"],
    // Values the shell decides.
    ["git -C $X", `git -C $X ${R.slice(4)}`, "linked"],
    ["git -C with a substitution", `git -C "$(pwd)" ${R.slice(4)}`, "linked"],
    ["git -C ~", `git -C ~ ${R.slice(4)}`, "linked"],
    ["cd $X", `cd $X && ${R}`, "linked"],
    ["cd with a substitution", `cd "$(mktemp -d)" && ${R}`, "linked"],
    ["cd ~", `cd ~ && ${R}`, "linked"],
    ["cd -", `cd - && ${R}`, "linked"],
    ["a bare cd", `cd && ${R}`, "linked"],
    ["pushd", `pushd {linked} && ${R}`, "linked"],
    ["popd", `popd && ${R}`, "linked"],
    ["--target $X", "git filter-repo --target $X --path a", "linked"],
    // Steps that do not resolve.
    ["a missing -C directory", `git -C missing ${R.slice(4)}`, "linked"],
    ["a missing cd directory", `cd missing && ${R}`, "linked"],
    // A cd whose effect depends on shell structure.
    ["a cd after ||", `true || cd {linked}; ${R}`, "canonical"],
    ["a cd inside an if", `if true; then cd {linked}; fi; ${R}`, "canonical"],
    ["a cd inside a loop", `for i in 1; do cd {linked}; done; ${R}`, "canonical"],
    ["a cd through eval", `eval 'cd {linked}'; ${R}`, "canonical"],
    ["a cd before a nested script", `cd {linked} && bash -c '${R}'`, "canonical"],
    // Repository overrides.
    ["--git-dir", `git --git-dir={linked}/.git ${R.slice(4)}`, "linked"],
    ["--work-tree", `git --work-tree={linked} ${R.slice(4)}`, "linked"],
    ["GIT_DIR", `GIT_DIR=/x/.git ${R}`, "linked"],
    ["GIT_WORK_TREE", `GIT_WORK_TREE=/x ${R}`, "linked"],
    // Launchers.
    ["an unreadable uv command line that names filter-repo", "uv weird-subcommand git-filter-repo --path a", "linked"],
    ["an unreadable pipx command line that names filter-repo", "pipx exotic git-filter-repo --path a", "linked"],
    // Branch deletes it cannot read.
    ["update-ref -d of an expanded ref", "git update-ref -d $REF", "canonical"],
  ]
  test.each(uncertain)("refuses %s", (_name, command, cwd) => {
    const refusal = run(command, cwd)
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("workdir")
  })

  test("the refusal says why the directory is uncertain", () => {
    expect(run(`git -C $X ${R.slice(4)}`, "linked")?.reason).toContain("cannot tell with certainty")
    expect(run(R, "canonical")?.reason).toContain("canonical checkout")
  })
})

describe("update-ref --stdin is read exactly or refused", () => {
  const refusedInCanonical = [
    ["a literal delete", "git update-ref --stdin <<EOF\ndelete refs/heads/main\nEOF"],
    ["a here-string delete", "git update-ref --stdin <<< 'delete refs/heads/main'"],
    ["a delete among tag updates", "git update-ref --stdin <<EOF\nupdate refs/tags/v1 abc\ndelete refs/heads/old\nEOF"],
    ["a zero-OID update", `git update-ref --stdin <<EOF\nupdate refs/heads/main ${ZERO}\nEOF`],
    ["an update with no new value", "git update-ref --stdin <<EOF\nupdate refs/heads/main\nEOF"],
    ["an update with an empty new value", "git update-ref --stdin <<EOF\nupdate refs/heads/main  abc\nEOF"],
    ["a quoted empty new value", 'git update-ref --stdin <<EOF\nupdate refs/heads/main ""\nEOF'],
    ["a quoted ref", 'git update-ref --stdin <<EOF\ndelete "refs/heads/main"\nEOF'],
    ["a quoted tag ref", 'git update-ref --stdin <<EOF\ndelete "refs/tags/v1"\nEOF'],
    ["a C-style escaped ref", 'git update-ref --stdin <<< \'delete "refs/heads/ma\\151n"\''],
    ["deleting HEAD's branch", "git update-ref --stdin <<EOF\ndelete HEAD\nEOF"],
    ["a pipe", "printf 'delete refs/heads/main\\n' | git update-ref --stdin"],
    ["a file", "git update-ref --stdin < ops.txt"],
    ["no stdin at all", "git update-ref --stdin"],
    ["-z input", "git update-ref -z --stdin <<< 'x'"],
    ["an expanded here-string", 'git update-ref --stdin <<< "delete refs/heads/$B"'],
    ["an expanded here-document", "git update-ref --stdin <<EOF\ndelete refs/heads/$B\nEOF"],
  ] as const
  test.each(refusedInCanonical)("refuses %s in a canonical checkout", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  test.each(refusedInCanonical)("refuses %s from a canonical checkout even through -C into a symlinked directory", (_name, command) => {
    expect(run(command.replace("git update-ref", "git -C {canonical}/sub update-ref"), "linked")?.guard).toBe(
      "history-rewrite",
    )
  })

  test.each([
    ["delete refs/tags/v1"],
    ["update refs/remotes/origin/x abc\ndelete refs/remotes/origin/y"],
    ["create refs/heads/new abc"],
    ["start\nupdate refs/tags/v1 abc\nprepare\ncommit"],
  ])("leaves a readable transaction that spares branches alone: %s", (body) => {
    expect(run(`git update-ref --stdin <<EOF\n${body}\nEOF`, "canonical")).toBeUndefined()
  })
})

describe("filter-repo --force is refused everywhere", () => {
  test.each([
    "git filter-repo --force --path a",
    "git filter-repo --path a --force",
    "git-filter-repo -f --path a",
    "uvx git-filter-repo --source /x --subdirectory-filter X --force",
    "uvx git-filter-repo@2.47.0 --force --path a",
    "uv tool run git-filter-repo@2.47.0 -f",
    "pipx run git-filter-repo --force",
    "pipenv run git-filter-repo --force",
    "uv --directory . tool run git-filter-repo --force",
  ])("%s", (command) => {
    for (const cwd of ["canonical", "linked", "clone", "plain"]) {
      const refusal = run(command, cwd)
      expect(refusal?.reason).toContain("--force")
    }
  })
})

describe("launcher spellings", () => {
  test.each([
    "uvx git-filter-repo@2.47.0 --path a",
    "uvx git-filter-repo==2.47.0 --path a",
    "uv tool run git-filter-repo@2.47.0 --path a",
    "uv run git-filter-repo --path a",
    "uv --directory . tool run git-filter-repo --path a",
    "uv --quiet --directory . run git-filter-repo --path a",
    "pipx run git-filter-repo==2.47.0 --path a",
    "pipx --quiet run git-filter-repo --path a",
    "pipenv run git-filter-repo --path a",
    "uvx --from git-filter-repo==2.47 git-filter-repo --path a",
    "uvx -p 3.12 git-filter-repo@latest --path a",
    "python3 /opt/bin/git-filter-repo --path a",
    "python3 -m git_filter_repo --path a",
  ])("refuses %s in a canonical checkout and allows it in a linked worktree", (command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
    expect(run(command, "linked")).toBeUndefined()
  })

  test.each([
    "uv pip install git-filter-repo",
    "uv tool install git-filter-repo",
    "uv --directory . pip install git-filter-repo",
    "pip install git-filter-repo",
    "pipx install git-filter-repo",
    "pipenv install git-filter-repo",
    "uvx ruff check .",
    "python3 -c 'print(1)'",
    "python3 script.py git-filter-repo --force",
  ])("does not treat %s as running filter-repo", (command) => {
    expect(run(command, "canonical")).toBeUndefined()
  })
})

describe("ordinary git is untouched in a canonical checkout", () => {
  test.each([
    "git status",
    "git log --oneline",
    "git commit -m 'filter-repo --force'",
    "git fetch origin",
    "git push origin main",
    "git rebase -i HEAD~3",
    "git branch -d old",
    "git tag -d v1",
    "git replace --list",
    "git replace -l",
    "git update-ref refs/heads/main abc123",
    "git update-ref -d refs/tags/v1",
    "git update-ref -d refs/remotes/origin/x",
    "git -C {linked} status",
    "echo git filter-repo --path a",
    'grep -r "git filter-branch" docs',
    "cd {linked} && git status",
    "cd $X && git status",
    "pushd {linked} && git log",
  ])("%s", (command) => {
    expect(run(command, "canonical")).toBeUndefined()
  })
})

test("the guard can be switched off", () => {
  expect(
    hardGate(R, where.canonical as string, { tempRoots: [join(root, "temp")], disabled: new Set(["history-rewrite"]) }),
  ).toBeUndefined()
})
