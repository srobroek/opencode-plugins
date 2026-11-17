/**
 * The history-rewrite guard fails closed and does not model the shell: a rewrite passes only when
 * its command contains nothing that could change the directory, and the workdir plus the command's
 * own `-C`/`--target`/`--git-dir`/`--work-tree` resolve to a temp clone or a verified linked
 * worktree, by the logical and the physical rule.
 *
 * Layout (tempRoots = [temp], so only `temp/clone` is a temp clone):
 *   canonical/.git/                   canonical checkout; its worktrees/linked has commondir + gitdir
 *   linked/.git (gitfile)             verified linked worktree of canonical
 *   submodule/.git (gitfile)          gitfile into canonical/.git/modules/sm
 *   separate/.git (gitfile)           gitfile into a separate git dir
 *   half/.git, mismatch/.git, garbage/.git   gitfiles with incomplete, misdirected or invalid metadata
 *   fifo/.git (a FIFO), fifometa/.git (metadata with a FIFO commondir), symlinked/.git (a symlink to a gitfile)
 *   temp/clone/.git/                  temp clone
 *   plain/                            not a repository; plain/link -> ../canonical/sub
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
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
  const file = (content: string, ...parts: string[]) => writeFileSync(join(root, ...parts), content)
  dir("canonical", ".git", "worktrees", "linked")
  dir("canonical", ".git", "worktrees", "half")
  dir("canonical", ".git", "modules", "sm")
  dir("canonical", "sub")
  file("../..\n", "canonical", ".git", "worktrees", "linked", "commondir")
  file(`${join(root, "linked", ".git")}\n`, "canonical", ".git", "worktrees", "linked", "gitdir")
  file(`${join(root, "half", ".git")}\n`, "canonical", ".git", "worktrees", "half", "gitdir")
  dir("linked", "sub")
  file(`gitdir: ${join(root, "canonical", ".git", "worktrees", "linked")}\n`, "linked", ".git")
  dir("submodule")
  file(`gitdir: ${join(root, "canonical", ".git", "modules", "sm")}\n`, "submodule", ".git")
  dir("separate")
  dir("sepgit")
  file(`gitdir: ${join(root, "sepgit")}\n`, "separate", ".git")
  dir("half")
  file(`gitdir: ${join(root, "canonical", ".git", "worktrees", "half")}\n`, "half", ".git")
  dir("mismatch")
  file(`gitdir: ${join(root, "canonical", ".git", "worktrees", "linked")}\n`, "mismatch", ".git")
  dir("garbage")
  file("this is not a gitfile\n", "garbage", ".git")
  dir("fifo")
  spawnSync("mkfifo", [join(root, "fifo", ".git")])
  dir("canonical", ".git", "worktrees", "fifometa")
  spawnSync("mkfifo", [join(root, "canonical", ".git", "worktrees", "fifometa", "commondir")])
  file(`${join(root, "fifometa", ".git")}\n`, "canonical", ".git", "worktrees", "fifometa", "gitdir")
  dir("fifometa")
  file(`gitdir: ${join(root, "canonical", ".git", "worktrees", "fifometa")}\n`, "fifometa", ".git")
  dir("symlinked")
  symlinkSync(join(root, "linked", ".git"), join(root, "symlinked", ".git"))
  dir("temp", "clone", ".git")
  dir("temp", "clone", "sub")
  dir("plain")
  symlinkSync(join(root, "canonical", "sub"), join(root, "plain", "link"))
  where = {
    canonical: join(root, "canonical"),
    "canonical/sub": join(root, "canonical", "sub"),
    linked: join(root, "linked"),
    "linked/sub": join(root, "linked", "sub"),
    clone: join(root, "temp", "clone"),
    "clone/sub": join(root, "temp", "clone", "sub"),
    plain: join(root, "plain"),
    submodule: join(root, "submodule"),
    separate: join(root, "separate"),
    half: join(root, "half"),
    mismatch: join(root, "mismatch"),
    garbage: join(root, "garbage"),
    fifo: join(root, "fifo"),
    fifometa: join(root, "fifometa"),
    symlinked: join(root, "symlinked"),
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Substitute `{name}` with the absolute path of a layout directory. */
const fill = (command: string): string => command.replace(/\{([\w/-]+)\}/g, (_, name: string) => where[name] ?? name)
const run = (command: string, cwd: string, env: NodeJS.ProcessEnv = {}) =>
  hardGate(fill(command), where[cwd] as string, { tempRoots: [join(root, "temp")], env })

const R = "git filter-branch --env-filter true"
const ZERO = "0".repeat(40)

type Case = [name: string, command: string, cwd: string]

const expectRefused = (command: string, cwd: string): void => {
  const refusal = run(command, cwd)
  expect(refusal?.guard).toBe("history-rewrite")
  expect(refusal?.reason).toContain("workdir")
}

describe("a rewrite passes only in a temp clone or a verified linked worktree", () => {
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
    ["chained -C into a linked subdirectory", `git -C {linked} -C sub ${R.slice(4)}`, "canonical"],
    ["--target into a linked worktree", "git filter-repo --target {linked} --path a", "canonical"],
    ["a sole literal transaction in a linked worktree", "git update-ref --stdin <<< 'delete refs/heads/main'", "linked"],
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
    ["update-ref -d of an expanded ref", "git update-ref -d $REF", "canonical"],
    ["-C into a canonical checkout", `git -C {canonical} ${R.slice(4)}`, "linked"],
    ["--target into a canonical checkout", "git filter-repo --target {canonical} --path a", "linked"],
    ["--work-tree of a canonical checkout", `git --work-tree={canonical} ${R.slice(4)}`, "clone"],
    ["--git-dir of a canonical checkout", `git --git-dir={canonical}/.git ${R.slice(4)}`, "clone"],
    ["--git-dir outside the temp folder, even with a temp work tree", `git --git-dir={canonical}/.git --work-tree={clone} ${R.slice(4)}`, "clone"],
    ["GIT_DIR of a canonical checkout", `GIT_DIR={canonical}/.git ${R}`, "clone"],
    ["GIT_WORK_TREE of a canonical checkout", `GIT_WORK_TREE={canonical} ${R}`, "clone"],
    ["an unknown git global option", `git --no-such-option ${R.slice(4)}`, "linked"],
  ]
  test.each(refused)("refuses %s", (_name, command, cwd) => {
    expectRefused(command, cwd)
  })
})

describe("a FIFO where metadata belongs cannot hang the guard", () => {
  test.each(["fifo", "fifometa"])("%s is refused promptly", (cwd) => {
    // A blocking open would hang the process; run it in a child with a hard timeout.
    const code = `import { hardGate } from ${JSON.stringify(join(import.meta.dir, "guards.ts"))}
const refusal = hardGate(${JSON.stringify(R)}, ${JSON.stringify(where[cwd])}, { tempRoots: [${JSON.stringify(join(root, "temp"))}], env: {} })
console.log(refusal?.guard ?? "allowed")`
    const child = spawnSync(process.execPath, ["-e", code], { timeout: 30_000, encoding: "utf8" })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe("history-rewrite")
  })
})

describe("a .git file proves a linked worktree only with matching metadata", () => {
  test.each([
    ["a submodule checkout", "submodule"],
    ["a separate git directory", "separate"],
    ["a worktree entry without a commondir file", "half"],
    ["a worktree entry that points back at another checkout", "mismatch"],
    ["an unreadable gitfile", "garbage"],
    ["a .git FIFO", "fifo"],
    ["worktree metadata with a FIFO commondir", "fifometa"],
    ["a symlinked gitfile", "symlinked"],
  ])("refuses %s", (_name, cwd) => {
    const refusal = run(R, cwd)
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("not a verified linked worktree")
  })

  test("allows the same gitfile layouts inside a temp folder", () => {
    // A temp clone is disposable whatever its .git looks like.
    expect(hardGate(R, where.submodule as string, { tempRoots: [root] })).toBeUndefined()
  })
})

describe("anything in the same command that could change the directory is refused", () => {
  // Every row runs from a linked worktree, where the rewrite alone would pass.
  const constructs: Case[] = [
    ["cd", `cd sub && ${R}`, "linked"],
    ["a quoted cd", `cd "{linked}" && ${R}`, "linked"],
    ["cd after the rewrite", `${R}; cd /tmp`, "linked"],
    ["cd in a subshell", `(cd sub); ${R}`, "linked"],
    ["cd in a pipeline", `cd sub | cat; ${R}`, "linked"],
    ["cd in the background", `cd sub & ${R}`, "linked"],
    ["cd behind a skipped &&", `false && cd sub; ${R}`, "linked"],
    ["cd behind ||", `true || cd sub; ${R}`, "linked"],
    ["cd in an if", `if true; then cd sub; fi; ${R}`, "linked"],
    ["a nested subshell cd", `cd {linked}; ( cd {canonical}; ${R} )`, "linked"],
    ["a cd to a file", `cd {linked}/.git && ${R}`, "linked"],
    ["pushd", `pushd {linked} && ${R}`, "linked"],
    ["popd", `popd && ${R}`, "linked"],
    ["env -C", `env -C {canonical} git filter-branch --env-filter true`, "linked"],
    ["env --chdir", `env --chdir={canonical} git filter-branch --env-filter true`, "linked"],
    ["sudo -D", `sudo -D {canonical} git filter-branch --env-filter true`, "linked"],
    ["git --exec-path", `git --exec-path=/x ${R.slice(4)}`, "linked"],
    ["bash -c", `bash -c '${R}'`, "linked"],
    ["sh -c", `sh -c '${R}'`, "linked"],
    ["zsh -c", `zsh -c '${R}'`, "linked"],
    ["fish -c", `fish -c '${R}'`, "linked"],
    ["a script run by a shell", `bash script.sh; ${R}`, "linked"],
    ["eval", `eval 'true'; ${R}`, "linked"],
    ["source", `source ./env.sh; ${R}`, "linked"],
    ["dot", `. ./env.sh; ${R}`, "linked"],
    ["xargs", "echo a | xargs git replace b", "linked"],
    ["exec", `exec ${R}`, "linked"],
    ["a function definition", `f() { cd /; }; ${R}`, "linked"],
    ["a function keyword definition", `function f { :; }; ${R}`, "linked"],
    ["an alias", `alias g=git; ${R}`, "linked"],
    ["unalias", `unalias git; ${R}`, "linked"],
  ]
  test.each(constructs)("refuses a rewrite with %s", (_name, command, cwd) => {
    const refusal = run(command, cwd)
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("workdir")
    expect(refusal?.reason).toContain("on its own")
  })

  test("the same constructs are harmless for ordinary git", () => {
    for (const command of [
      "cd {linked} && git status",
      "cd $X && git log",
      "pushd {linked} && git diff",
      "bash -c 'git status'",
      "eval 'git status'",
      "f() { git status; }; f",
      "env -C {linked} git status",
      "git --exec-path=/x status",
      "echo a | xargs git show",
    ])
      expect(run(command, "canonical")).toBeUndefined()
  })
})

describe("anything that can select another repository is refused", () => {
  const selection: Case[] = [
    ["--work-tree to a temp clone", `git --work-tree={clone} update-ref -d refs/heads/main`, "canonical"],
    ["--work-tree=... to a linked worktree", `git --work-tree={linked} ${R.slice(4)}`, "linked"],
    ["--git-dir", `git --git-dir={clone}/.git ${R.slice(4)}`, "clone"],
    ["--git-dir and --work-tree of a temp clone", `git --git-dir={clone}/.git --work-tree={clone} ${R.slice(4)}`, "canonical"],
    ["GIT_DIR and GIT_WORK_TREE", `GIT_DIR={clone}/.git GIT_WORK_TREE={clone} ${R}`, "canonical"],
    ["an environment assignment under a CLI option", `GIT_WORK_TREE={canonical} git --work-tree={clone} ${R.slice(4)}`, "clone"],
    ["a CLI option under an environment assignment", `GIT_DIR={canonical}/.git git --git-dir={clone}/.git ${R.slice(4)}`, "clone"],
    ["env GIT_DIR=", `env GIT_DIR={clone}/.git ${R}`, "canonical"],
    ["env GIT_WORK_TREE=", `env GIT_WORK_TREE={clone} ${R}`, "canonical"],
    ["any env wrapper", `env FOO=1 ${R}`, "linked"],
    ["an env wrapper with unset", `env -u FOO ${R}`, "linked"],
    ["an exported GIT_DIR", `export GIT_DIR={clone}/.git; ${R}`, "canonical"],
    ["GIT_COMMON_DIR", `GIT_COMMON_DIR={clone}/.git ${R}`, "linked"],
    ["GIT_INDEX_FILE", `GIT_INDEX_FILE=/x/index ${R}`, "linked"],
    ["GIT_OBJECT_DIRECTORY", `GIT_OBJECT_DIRECTORY=/x/objects ${R}`, "linked"],
    ["-c core.worktree", `git -c core.worktree={clone} ${R.slice(4)}`, "canonical"],
    ["-ccore.worktree", `git -ccore.worktree={clone} ${R.slice(4)}`, "canonical"],
    ["-c core.bare", `git -c core.bare=true ${R.slice(4)}`, "linked"],
    ["--config-env", `git --config-env=core.worktree=WT ${R.slice(4)}`, "canonical"],
    ["builtin cd", `builtin cd {linked} && ${R}`, "canonical"],
    ["command cd", `command cd {linked} && ${R}`, "canonical"],
    ["command dispatch", `command ${R}`, "linked"],
    ["builtin dispatch", `builtin eval 'true'; ${R}`, "linked"],
  ]
  test.each(selection)("refuses a rewrite with %s", (_name, command, cwd) => {
    const refusal = run(command, cwd)
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("workdir")
  })

  test.each([
    ["GIT_DIR", { GIT_DIR: "/secret/git-dir" }],
    ["GIT_WORK_TREE", { GIT_WORK_TREE: "/secret/work-tree" }],
    ["GIT_COMMON_DIR", { GIT_COMMON_DIR: "/secret/common" }],
    ["an empty GIT_DIR", { GIT_DIR: "" }],
  ])("refuses a rewrite when the session environment sets %s, naming it but never its value", (_name, env) => {
    for (const cwd of ["linked", "clone", "canonical"]) {
      const refusal = run(R, cwd, env)
      expect(refusal?.guard).toBe("history-rewrite")
      expect(refusal?.reason).toContain(Object.keys(env)[0] as string)
      expect(refusal?.reason).not.toContain("/secret")
    }
  })

  test("other inherited variables, and an unset environment, change nothing", () => {
    expect(run(R, "linked", { GIT_INDEX_FILE: "/x", HOME: "/h", GIT_AUTHOR_NAME: "a" })).toBeUndefined()
    expect(run(R, "linked", {})).toBeUndefined()
  })

  test("ordinary git with these options and variables is untouched", () => {
    const env = { GIT_DIR: "/secret/git-dir", GIT_WORK_TREE: "/secret/work-tree" }
    for (const command of [
      "git --git-dir={clone}/.git status",
      "git --work-tree={clone} diff",
      "GIT_DIR={clone}/.git git log",
      "env GIT_DIR={clone}/.git git status",
      "export GIT_WORK_TREE={clone}; git status",
      "git -c core.worktree={clone} status",
      "git --config-env=core.worktree=WT status",
      "builtin cd {linked}",
      "command cd {linked} && git status",
      "command -v git",
      "env FOO=1 git log",
      "git update-ref refs/heads/main abc123",
      "git update-ref -d refs/tags/v1",
    ]) {
      expect(run(command, "canonical")).toBeUndefined()
      expect(run(command, "canonical", env)).toBeUndefined()
    }
  })
})

describe("anything the directory options cannot settle is refused", () => {
  const uncertain: Case[] = [
    // The lexical `..` and the physical `..` through a symlink disagree.
    ["-C link/..", `git -C link/.. ${R.slice(4)}`, "plain"],
    ["chained -C link then ..", `git -C link -C .. ${R.slice(4)}`, "plain"],
    ["--target link/..", "git filter-repo --target link/.. --path a", "plain"],
    ["--work-tree link/..", `git --work-tree=link/.. ${R.slice(4)}`, "plain"],
    // Values the shell decides.
    ["git -C $X", `git -C $X ${R.slice(4)}`, "linked"],
    ["git -C with a substitution", `git -C "$(pwd)" ${R.slice(4)}`, "linked"],
    ["git -C ~", `git -C ~ ${R.slice(4)}`, "linked"],
    ["--target $X", "git filter-repo --target $X --path a", "linked"],
    ["--git-dir $X", `git --git-dir=$X ${R.slice(4)}`, "linked"],
    ["GIT_DIR=$X", `GIT_DIR=$X ${R}`, "linked"],
    // Steps that do not resolve to a directory.
    ["a missing -C directory", `git -C missing ${R.slice(4)}`, "linked"],
    ["a -C step that is a file", `git -C {linked}/.git ${R.slice(4)}`, "canonical"],
    ["a -C step through a file", `git -C {linked}/.git/x ${R.slice(4)}`, "canonical"],
    ["a --target that is a file", "git filter-repo --target {linked}/.git --path a", "canonical"],
    ["a --work-tree that is a file", `git --work-tree={linked}/.git ${R.slice(4)}`, "canonical"],
    // Launchers.
    ["an unreadable uv command line that names filter-repo", "uv weird-subcommand git-filter-repo --path a", "linked"],
    ["an unreadable pipx command line that names filter-repo", "pipx exotic git-filter-repo --path a", "linked"],
  ]
  test.each(uncertain)("refuses %s", (_name, command, cwd) => {
    const refusal = run(command, cwd)
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("workdir")
  })

  test("the refusals say why", () => {
    expect(run(`git -C $X ${R.slice(4)}`, "linked")?.reason).toContain("cannot tell with certainty")
    expect(run(R, "canonical")?.reason).toContain("canonical checkout")
    expect(run(`cd sub && ${R}`, "linked")?.reason).toContain("also contains `cd`")
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
    ["a C-style escaped ref", "git update-ref --stdin <<< 'delete \"refs/heads/ma\\151n\"'"],
    ["deleting HEAD's branch", "git update-ref --stdin <<EOF\ndelete HEAD\nEOF"],
    ["a pipe", "printf 'delete refs/heads/main\\n' | git update-ref --stdin"],
    ["a file", "git update-ref --stdin < ops.txt"],
    ["no stdin at all", "git update-ref --stdin"],
    ["-z input", "git update-ref -z --stdin <<< 'x'"],
    ["an expanded here-string", 'git update-ref --stdin <<< "delete refs/heads/$B"'],
    ["an expanded here-document", "git update-ref --stdin <<EOF\ndelete refs/heads/$B\nEOF"],
    // The shell uses the LAST stdin redirection, so two of them are never parsed.
    ["a tag-only here-string followed by a file", "git update-ref --stdin <<< 'delete refs/tags/v1' < ops.txt"],
    ["a file followed by a tag-only here-string", "git update-ref --stdin < ops.txt <<< 'delete refs/tags/v1'"],
    ["two here-strings", "git update-ref --stdin <<< 'delete refs/tags/v1' <<< 'delete refs/heads/main'"],
    ["a here-document and a here-string", "git update-ref --stdin <<< 'delete refs/tags/v1' <<EOF\ndelete refs/heads/main\nEOF"],
    ["a descriptor duplicated onto stdin", "git update-ref --stdin <<< 'delete refs/tags/v1' <&3"],
    ["a read-write redirection", "git update-ref --stdin <> ops.txt"],
    ["a here-string on another descriptor only", "git update-ref --stdin 3<<< 'delete refs/tags/v1'"],
  ] as const
  test.each(refusedInCanonical)("refuses %s in a canonical checkout", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  test.each(refusedInCanonical)("refuses %s through -C into a canonical checkout", (_name, command) => {
    expect(run(command.replace("git update-ref", "git -C {canonical}/sub update-ref"), "linked")?.guard).toBe(
      "history-rewrite",
    )
  })

  test.each([
    ["delete refs/tags/v1"],
    ["update refs/remotes/origin/x abc\ndelete refs/remotes/origin/y"],
    ["create refs/heads/new abc"],
    ["start\nupdate refs/tags/v1 abc\nprepare\ncommit"],
  ])("leaves a sole literal transaction that spares branches alone: %s", (body) => {
    expect(run(`git update-ref --stdin <<EOF\n${body}\nEOF`, "canonical")).toBeUndefined()
  })

  test("a sole literal here-string on stdout-redirected output is still read", () => {
    expect(run("git update-ref --stdin <<< 'delete refs/tags/v1' > out.txt", "canonical")).toBeUndefined()
    expect(run("git update-ref --stdin <<< 'delete refs/heads/main' > out.txt", "canonical")?.guard).toBe(
      "history-rewrite",
    )
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
      expect(run(command, cwd)?.reason).toContain("--force")
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

describe("a rewrite the walker cannot fully parse is refused", () => {
  test.each([
    ["a builtin-wrapped eval", "builtin eval 'git update-ref -d refs/heads/main'"],
    ["--config-env with a separate value", "git --config-env core.x=X filter-branch --env-filter true"],
    ["a repeated --target", "git filter-repo --target {linked} --target {canonical} --path a"],
    ["python -c code that runs git", "python3 -c 'import os; os.system(\"git update-ref -d refs/heads/main\")'"],
    ["a shell launched by uv run", "uv run bash -c \"builtin eval 'git update-ref -d refs/heads/main'\""],
    ["a shell launched by uvx", "uvx sh -c 'git update-ref -d refs/heads/main'"],
    ["a mixed-spelling --target", "git filter-repo --target {clone} --targ {canonical} --path a"],
    ["an abbreviated repeated --target", "git filter-repo --tar={clone} --ta {canonical} --path a"],
    ["git launched after a valued option", "uv run --package billing git update-ref -d refs/heads/main"],
    ["git filter-branch launched after --with", "uv run --with x git filter-branch --env-filter true"],
    ["a script that is handed a filter-repo word", "python3 script.py git-filter-repo --force"],
    ["a pager option after a cluster that ends in a file option", "git grep -fe -O'sh -c \"git update-ref -d refs/heads/main\"' x"],
    ["a cluster that includes the pager option", "git grep -iO'sh -c \"git update-ref -d refs/heads/main\"' x"],
    ["git grep -O with a pager command", "git grep -O'sh -c \"git update-ref -d refs/heads/main\"' x"],
    ["git grep --open-files-in-pager", "git grep --open-files-in-pager='sh -c \"git update-ref -d refs/heads/main\"' x"],
    ["git diff --ext-diff with a mention", "git diff --ext-diff --foo='git update-ref -d refs/heads/main'"],
    ["rg --pre with a mention", "rg --pre='git update-ref -d refs/heads/main' x ."],
    ["git launched by uv run", "uv run git update-ref -d refs/heads/main"],
    ["a nested launcher with --force", "uv run uv run git-filter-repo --force"],
    ["a nested launcher behind --from", "uvx --from x uv run git-filter-repo"],
    ["a git alias that runs a rewrite", "git -c alias.x='!git update-ref -d refs/heads/main' x"],
  ])("refuses %s", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  test.each([
    ["a repeated --source", "git filter-repo --source {clone} --sourc {canonical} --path a"],
    ["an abbreviated --force", "git filter-repo --forc --path a"],
  ])("refuses %s even in a temp clone", (_name, command) => {
    expect(run(command, "clone")?.guard).toBe("history-rewrite")
  })

  test.each([
    "grep filter-repo README.md",
    "rg update-ref plugins/",
    "echo update-ref",
    "git log --grep=filter-branch",
    "cat docs/filter-repo.md",
    'git commit -m "fix update-ref guard"',
    'git commit -am "fix update-ref guard"',
    'grep -rie "git filter-branch" docs/',
    'bd create --description "git replace misuse"',
    "uv run --directory {linked} pytest",
  ])("allows the mention in %s", (command) => {
    expect(run(command, "canonical")).toBeUndefined()
  })
})

test("the guard can be switched off", () => {
  expect(
    hardGate(R, where.canonical as string, { tempRoots: [join(root, "temp")], disabled: new Set(["history-rewrite"]) }),
  ).toBeUndefined()
})
