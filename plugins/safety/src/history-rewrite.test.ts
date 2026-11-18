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
  // A decoy whose name holds literal backslashes: the text `\056\056/canonical` resolves here, but the shell decodes it to `../canonical`.
  dir("linked", "\\056\\056", "canonical")
  file("", "canonical", "pyproject.toml")
  file("", "linked", "pyproject.toml")
  file("", "temp", "clone", "sub", "pyproject.toml")
  dir("plain")
  // Siblings of `canonical` whose names are glob or brace patterns that match it: a literal check finds them, the shell does not.
  for (const name of ["[c]anonical", "?anonical", "canon*", "{canonical,x}"]) dir(name)
  symlinkSync(join(root, "canonical", "sub"), join(root, "plain", "link"))
  where = {
    root,
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
    // An unquoted here-document loses each backslash-newline before git reads it.
    ["a verb split by a continuation", "git update-ref --stdin <<EOF\ndel\\\nete refs/heads/main\nEOF"],
    ["a ref split by a continuation", "git update-ref --stdin <<EOF\ndelete refs/he\\\nads/main\nEOF"],
    ["a zero-OID update split by a continuation", `git update-ref --stdin <<EOF\nupdate refs/heads/main 0000\\\n${"0".repeat(36)}\nEOF`],
    ["a continuation in an indented <<- here-document", "git update-ref --stdin <<-EOF\n\tdel\\\nete refs/heads/main\nEOF"],
    ["a substitution in an unquoted here-document", "git update-ref --stdin <<EOF\n$(echo delete) refs/heads/main\nEOF"],
    ["a backtick in an unquoted here-document", "git update-ref --stdin <<EOF\n`echo delete` refs/heads/main\nEOF"],
    ["a variable in an unquoted here-document", "git update-ref --stdin <<EOF\n$V refs/heads/main\nEOF"],
    ["a variable in a tag-only unquoted here-document", "git update-ref --stdin <<EOF\ndelete refs/tags/$T\nEOF"],
    ["a verb split in a here-string", "git update-ref --stdin <<< del\\\nete\\ refs/heads/main"],
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

  test.each([
    ["a tag-only delete with a variable", "delete refs/tags/$T"],
    ["a split verb on a tag", "del\\\nete refs/tags/v1"],
    ["a split line that git reads as two non-transactions", "del\\\nete refs/remotes/origin/x"],
  ])("judges a quoted here-document by its content: %s", (_name, body) => {
    // A quoted delimiter keeps the body literal: no expansion, no continuation joining.
    expect(run(`git update-ref --stdin <<'EOF'\n${body}\nEOF`, "canonical")).toBeUndefined()
  })

  test.each([
    "delete refs/heads/main",
    "delete refs/heads/$B",
    "update refs/heads/main",
  ])("still refuses a branch delete in a quoted here-document: %s", (body) => {
    expect(run(`git update-ref --stdin <<'EOF'\n${body}\nEOF`, "canonical")?.guard).toBe("history-rewrite")
  })

  test("a continuation joins nothing in a quoted here-document", () => {
    expect(run("git update-ref --stdin <<'EOF'\ndelete refs/tags/v1\\\nx\nEOF", "canonical")).toBeUndefined()
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

describe("uv's directory options decide where the rewrite runs", () => {
  const launchers = [
    "uvx {opt} git-filter-repo --path a",
    "uv tool run {opt} git-filter-repo --path a",
    "uv run {opt} git-filter-repo --path a",
    "uv {opt} run git-filter-repo --path a",
    "uv {opt} tool run git-filter-repo --path a",
  ]
  const options = ["--directory={d}", "--directory {d}", "--project={d}", "--project {d}"]
  const cases = launchers.flatMap((launcher) => options.map((option) => launcher.replace("{opt}", option)))

  test.each(cases)("refuses %s into a canonical checkout from a linked worktree", (command) => {
    expect(run(command.replace("{d}", "{canonical}"), "linked")?.guard).toBe("history-rewrite")
  })

  test.each(cases)("allows %s into another linked worktree", (command) => {
    // --directory moves the process; --project only names a project, so the start directory still counts.
    expect(run(command.replace("{d}", "{linked}"), "canonical")?.guard).toBe(
      command.includes("--directory") ? undefined : "history-rewrite",
    )
    expect(run(command.replace("{d}", "{linked}"), "linked")).toBeUndefined()
  })

  test("resolves --project from the directory --directory selects", () => {
    // Run from a canonical checkout: the process and the project both end up inside the temp clone.
    expect(run("uvx --directory {clone} --project sub git-filter-repo --path a", "canonical")).toBeUndefined()
    expect(run("uv --directory={clone} run --project=sub git-filter-repo --path a", "canonical")).toBeUndefined()
    expect(run("uvx --directory {clone} --project {canonical} git-filter-repo --path a", "canonical")?.guard).toBe(
      "history-rewrite",
    )
    expect(run("uvx --directory {clone} --project ../../canonical git-filter-repo --path a", "linked")?.guard).toBe(
      "history-rewrite",
    )
  })

  test("normalizes a project file to the directory that holds it", () => {
    expect(run("uvx --project {linked}/pyproject.toml git-filter-repo --path a", "linked")).toBeUndefined()
    expect(run("uvx --project {canonical}/pyproject.toml git-filter-repo --path a", "linked")?.guard).toBe("history-rewrite")
    expect(run("uvx --project pyproject.toml git-filter-repo --path a", "canonical")?.guard).toBe("history-rewrite")
    expect(run("uvx --directory {clone}/sub --project pyproject.toml git-filter-repo --path a", "canonical")).toBeUndefined()
  })

  test.each([
    ["uvx", "UV_WORKING_DIR={canonical} uvx git-filter-repo --path a"],
    ["uv run", "UV_WORKING_DIR={canonical} uv run git-filter-repo --path a"],
    ["a quoted value", 'UV_WORKING_DIR="{canonical}" uvx git-filter-repo --path a'],
    ["a project variable", "UV_PROJECT={canonical} uvx git-filter-repo --path a"],
    ["a project file variable", "UV_PROJECT={canonical}/pyproject.toml uvx git-filter-repo --path a"],
    ["an expanded value", "UV_WORKING_DIR=$D uvx git-filter-repo --path a"],
    ["an expanded project", "UV_PROJECT=$D uvx git-filter-repo --path a"],
    ["env", "env UV_WORKING_DIR={canonical} uvx git-filter-repo --path a"],
    ["env for the project", "env UV_PROJECT={canonical} uvx git-filter-repo --path a"],
  ])("refuses %s from a linked worktree", (_name, command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
  })

  test("allows the variables when they name a linked worktree or temp clone", () => {
    expect(run("UV_WORKING_DIR={clone} uvx git-filter-repo --path a", "canonical")).toBeUndefined()
    expect(run("UV_PROJECT={linked} uvx git-filter-repo --path a", "linked")).toBeUndefined()
    expect(run("UV_WORKING_DIR={clone} UV_PROJECT=sub uvx git-filter-repo --path a", "canonical")).toBeUndefined()
  })

  test.each([
    ["sudo", "UV_WORKING_DIR={clone} sudo uvx git-filter-repo --path a"],
    ["env -i", "UV_WORKING_DIR={clone} env -i uvx git-filter-repo --path a"],
    ["nice", "UV_WORKING_DIR={clone} nice uvx git-filter-repo --path a"],
    ["nohup", "UV_WORKING_DIR={clone} nohup uvx git-filter-repo --path a"],
    ["timeout", "UV_WORKING_DIR={clone} timeout 60 uvx git-filter-repo --path a"],
    ["time", "UV_WORKING_DIR={clone} time uvx git-filter-repo --path a"],
    ["doas", "UV_PROJECT={clone} doas uvx git-filter-repo --path a"],
    ["command", "UV_WORKING_DIR={clone} command uvx git-filter-repo --path a"],
    ["a variable after the wrapper", "sudo UV_WORKING_DIR={clone} uvx git-filter-repo --path a"],
  ])("refuses an inline variable that crosses %s", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  test("still judges a wrapper without a uv variable by the workdir", () => {
    expect(run("sudo uvx git-filter-repo --path a", "linked")).toBeUndefined()
    expect(run("sudo uvx git-filter-repo --path a", "canonical")?.guard).toBe("history-rewrite")
  })

  test.each([
    ["export", "export UV_WORKING_DIR={clone}; uvx git-filter-repo --path a"],
    ["export project", "export UV_PROJECT={clone}; uvx git-filter-repo --path a"],
    ["a plain assignment", "UV_WORKING_DIR={clone}; uvx git-filter-repo --path a"],
    ["declare -x", "declare -x UV_WORKING_DIR={clone}; uvx git-filter-repo --path a"],
    ["set -a", "set -a; UV_WORKING_DIR={clone}; uvx git-filter-repo --path a"],
    ["set -a alone", "set -a && uvx git-filter-repo --path a"],
    ["an export on an earlier line", "export UV_PROJECT={clone}\nuv run git-filter-repo --path a"],
    ["an export without a value", "export UV_WORKING_DIR && uvx git-filter-repo --path a"],
    ["a conditional", "true && export UV_WORKING_DIR={canonical} && uvx git-filter-repo --path a"],
  ])("refuses an earlier setter: %s", (_name, command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
    expect(run(command, "clone")?.guard).toBe("history-rewrite")
  })

  test("ignores a later setter and unrelated exports", () => {
    expect(run("export FOO=1; uvx git-filter-repo --path a", "linked")).toBeUndefined()
    expect(run("uvx git-filter-repo --path a; export UV_WORKING_DIR={canonical}", "linked")).toBeUndefined()
  })

  test("an option beats the variable, as in uv", () => {
    expect(run("UV_WORKING_DIR={canonical} uvx --directory {linked} git-filter-repo --path a", "linked")).toBeUndefined()
    expect(run("UV_WORKING_DIR={linked} uvx --directory {canonical} git-filter-repo --path a", "linked")?.guard).toBe(
      "history-rewrite",
    )
  })

  test.each([
    "uvx --directory {linked} --directory {canonical} git-filter-repo",
    "uvx --directory={canonical} --directory={linked} git-filter-repo",
    "uv --directory {linked} run --directory {canonical} git-filter-repo",
    "uvx --project {linked} --project {canonical} git-filter-repo",
  ])("refuses a repeated option, which uv rejects: %s", (command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
  })

  test.each(["uvx --directory $D git-filter-repo", "uvx --directory git-filter-repo"])(
    "refuses %s when the directory cannot be resolved",
    (command) => {
      expect(run(command, "linked")?.guard).toBe("history-rewrite")
    },
  )
})

describe("a shell escape in a spelling the guard validates is refused", () => {
  const R2 = String.raw`$'\056\056/canonical'`
  // Run from a linked worktree: the decoy passes a literal check, the decoded value is the canonical checkout.
  test.each([
    ["uvx --directory", `uvx --directory ${R2} git-filter-repo --path a`],
    ["uvx --directory=", `uvx --directory=${R2} git-filter-repo --path a`],
    ["uv run --directory", `uv run --directory ${R2} git-filter-repo --path a`],
    ["uvx --project", `uvx --project ${R2} git-filter-repo --path a`],
    ["uvx --project=", `uvx --project=${R2} git-filter-repo --path a`],
    ["UV_WORKING_DIR", `UV_WORKING_DIR=${R2} uvx git-filter-repo --path a`],
    ["UV_PROJECT", `UV_PROJECT=${R2} uvx git-filter-repo --path a`],
    ["-C", `git -C ${R2} filter-branch --env-filter true`],
    ["-C on update-ref", `git -C ${R2} update-ref -d refs/heads/main`],
    ["--target", `git filter-repo --target ${R2} --path a`],
    ["--target=", `git filter-repo --target=${R2} --path a`],
    ["a single-quoted backslash", String.raw`git -C '\056\056/canonical' filter-branch --env-filter true`],
  ])("refuses an escaped directory in %s", (_name, command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
  })

  test.each([
    ["a git option name", String.raw`git $'--git-d\151r=x' filter-branch --env-filter true`],
    ["a git option name before update-ref", String.raw`git $'--work-tr\145e=x' update-ref -d refs/heads/main`],
    ["a filter-repo option name", String.raw`git filter-repo $'--tar\147et' {linked} --path a`],
    ["a uv option name", String.raw`uvx $'--dir\145ctory' {linked} git-filter-repo --path a`],
    ["a launched program", String.raw`uvx $'git-filter-r\145po' --path a`],
  ])("refuses %s spelled with an escape", (_name, command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
  })

  // Decision: the guard does not decode `$'…'`. A line that mixes ANSI-C or locale quoting with git or a
  // launcher is refused in a canonical checkout, even when it is harmless (`git $'sta\164us'`).
  const harmless = [
    ["a uv value with an escaped space", String.raw`uvx --directory=$'my\x20project' ruff check .`],
    ["a uv project with an escaped space", String.raw`uv run --project $'a\x20b' pytest`],
    ["an escaped git subcommand that is not a rewrite", String.raw`git $'sta\164us'`],
    ["an escaped git subcommand with options", String.raw`git $'l\157g' --oneline`],
    ["an escaped program that is not a rewrite", String.raw`uvx $'ru\146f' check .`],
    ["an escaped uv option name that is not a rewrite", String.raw`uvx $'--quie\164' ruff check .`],
    ["an escaped tag delete", String.raw`git update-ref -d $'refs/tags/v\061'`],
    ["a plain ANSI-C word", "git log $'--oneline'"],
    ["a locale string", 'git log $"--oneline"'],
  ] as const
  test.each(harmless)("refuses %s in a canonical checkout, because it cannot be verified", (_name, command) => {
    const refusal = run(command, "canonical")
    expect(refusal?.guard).toBe("history-rewrite")
    expect(refusal?.reason).toContain("without $'…' or $\"…\" quoting")
  })

  test("a git subcommand spelled with an escape passes in a linked worktree and a temp clone", () => {
    expect(run(String.raw`git $'sta\164us'`, "linked")).toBeUndefined()
    expect(run(String.raw`git $'l\157g' --oneline`, "clone")).toBeUndefined()
    expect(run("git log $'--oneline'", "linked")).toBeUndefined()
  })

  test.each([
    ["a branch ref spelled with an escape", String.raw`git update-ref -d $'\162efs/heads/main'`],
    ["the delete flag spelled with an escape", String.raw`git update-ref $'\055d' refs/heads/main`],
    ["a long delete flag spelled with an escape", String.raw`git update-ref $'--dele\164e' refs/heads/main`],
    ["a hex-escaped ref", String.raw`git update-ref -d $'refs/heads/\x6dain'`],
    ["an escaped subcommand", String.raw`git $'filter-r\145po' --path a`],
    ["an escaped filter-branch", String.raw`git $'filter-bran\143h' --env-filter true`],
    ["an escaped replace", String.raw`git $'repl\141ce' a b`],
    ["an escaped launcher program", String.raw`uvx $'git-filter-r\145po' --path a`],
    ["an escaped git command name", String.raw`$'g\151t' filter-branch --env-filter true`],
    // The reviewer's examples.
    ["an escaped git behind uv run", String.raw`uv run $'g\151t' $'filter-bran\143h'`],
    ["a control-@ NUL that truncates the subcommand", String.raw`git $'filter-bran\143h\c@junk'`],
    ["a NUL in a fragment before concatenation", String.raw`git update-ref -d $'\0'refs/heads/main`],
  ])("refuses %s in a canonical checkout", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  // From a linked worktree the only thing that can still reach a canonical checkout is a visible or hidden directory.
  test.each([
    ["an escaped branch ref through -C", String.raw`git -C {canonical} update-ref -d $'\162efs/heads/main'`],
    ["an escaped delete flag through -C", String.raw`git -C {canonical} update-ref $'\055d' refs/heads/main`],
    ["an escaped subcommand through -C", String.raw`git -C {canonical} $'sta\164us'`],
    ["an escaped subcommand with --target", String.raw`git $'filter-r\145po' --target {canonical} --path a`],
    ["an escaped subcommand with an abbreviated --target", String.raw`git $'filter-r\145po' --tar {canonical} --path a`],
    ["an escaped subcommand with --target=", String.raw`git $'filter-r\145po' --target={canonical} --path a`],
    ["an escaped uv option name", String.raw`uvx $'\055\055directory' {canonical} git-filter-repo --path a`],
    ["an escaped uv program with a visible directory", String.raw`uvx --directory {canonical} $'git-filter-r\145po' --path a`],
    ["an escaped git command name with -C", String.raw`$'g\151t' -C {canonical} filter-branch --env-filter true`],
    ["an escaped option name hiding a value", String.raw`git filter-repo $'\055\055target' {canonical} --path a`],
  ])("refuses %s from a linked worktree", (_name, command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
  })

  // Decision: a program word spelled with `$'…'` or `$"…"` is refused everywhere. It could be bash, git or a
  // launcher whose inner script the guard never reads, and nobody needs an escaped program name.
  const escapedPrograms = [
    String.raw`$'ec\150o' hi`,
    String.raw`$'pr\151ntf' x`,
    String.raw`/bin/$'l\163' -l`,
    String.raw`$'ec\150o' plain args | $'w\143' -c`,
    'ec$"ho" hi',
  ]
  test.each(escapedPrograms)("an escaped program is refused in every location: %s", (command) => {
    for (const cwd of ["canonical", "linked", "clone"]) {
      const refusal = run(command, cwd)
      expect(refusal?.guard).toBe("history-rewrite")
      expect(refusal?.reason).toContain("without $'…' or $\"…\" quoting")
    }
  })

  test("an escaped bash cannot hide an inner script from a linked worktree", () => {
    // The gate only reads the text; nothing here runs the inner command.
    const command = String.raw`/bin/$'ba\163h' -c 'g""it -C ../canonical update-""ref -d refs/heads/main'`
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
    expect(run(command, "clone")?.guard).toBe("history-rewrite")
  })

  test.each([
    ["an escaped slash", String.raw`/usr/bin$'\057git' filter-branch --env-filter true`],
    ["a NUL followed by a digit", String.raw`$'g\151t\x000junk' filter-branch --env-filter true`],
    ["a different case for a case-insensitive file system", String.raw`$'G\151T' filter-branch --env-filter true`],
    ["a visible -C", String.raw`$'ec\150o' -C {canonical} filter-branch --env-filter true`],
    ["a visible --directory", String.raw`$'ec\150o' --directory {canonical} git-filter-repo --path a`],
    ["a visible UV_WORKING_DIR", String.raw`UV_WORKING_DIR={canonical} $'ec\150o' git-filter-repo --path a`],
  ])("refuses %s in the program name from every location", (_name, command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)?.guard).toBe("history-rewrite")
  })

  test("a plain program with ANSI-C arguments passes everywhere", () => {
    for (const command of [String.raw`echo $'a\tb'`, String.raw`printf $'x\n'`, "ls $'dir'", String.raw`echo $'a\x20b' | wc -c`])
      for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
  })

  test.each([
    String.raw`$'g\151t' filter-branch --env-filter true`,
    String.raw`/usr/bin/$'g\151t' filter-branch --env-filter true`,
    String.raw`$'\147\151\164' filter-branch --env-filter true`,
    String.raw`$'\x67it' filter-branch --env-filter true`,
    String.raw`$'su\144o' git filter-branch --env-filter true`,
    String.raw`$'ba\163h' -c 'git filter-branch --env-filter true'`,
    String.raw`$'\0'git filter-branch --env-filter true`,
    String.raw`$'git\c@junk' filter-branch --env-filter true`,
    String.raw`$'u\166x' git-filter-repo --path a`,
    String.raw`$'python3.1\062' -m git_filter_repo`,
  ])("an escaped program that could spell git or a launcher is refused in a canonical checkout: %s", (command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  test("leaves ANSI-C quoting alone in commands that are neither git nor a launcher", () => {
    for (const command of [String.raw`printf $'a\nb'`, "echo $'x'", String.raw`echo $'a\tb' | wc -c`, 'echo $"x"'])
      for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
  })

  test("ordinary git without ANSI-C quoting passes in a canonical checkout", () => {
    expect(run("git status", "canonical")).toBeUndefined()
    expect(run("git log --oneline -n 3", "canonical")).toBeUndefined()
  })

  test("leaves a plain escape in an unrelated word alone", () => {
    expect(run(String.raw`git filter-repo --path-regex '^a\.' --path a`, "linked")).toBeUndefined()
    expect(run(String.raw`git filter-branch --msg-filter 'sed s/a\.b/c/' -- --all`, "linked")).toBeUndefined()
  })
})

describe("globs, braces and locale strings in a directory operand are refused", () => {
  // Run from the folder that holds `canonical` and a sibling named like a pattern that matches it.
  test.each([
    ["a bracket glob", "[c]anonical"],
    ["a question-mark glob", "?anonical"],
    ["a star glob", "canon*"],
    ["a brace list", "{canonical,x}"],
  ])("refuses %s in -C, --target and the uv options", (_name, operand) => {
    for (const command of [
      `git -C ${operand} filter-branch --env-filter true`,
      `git filter-repo --target ${operand} --path a`,
      `git filter-repo --target=${operand} --path a`,
      `uvx --directory ${operand} git-filter-repo --path a`,
      `uvx --project=${operand} git-filter-repo --path a`,
      `UV_WORKING_DIR=${operand} uvx git-filter-repo --path a`,
    ])
      expect(run(command, "root")?.guard).toBe("history-rewrite")
  })

  // bash translates `$"…"` when a message catalog is active, so the literal destination proves nothing.
  test.each([
    ["git -C", 'git -C $"{linked}" filter-branch --env-filter true'],
    ["--target", 'git filter-repo --target $"{linked}" --path a'],
    ["--target=", 'git filter-repo --target=$"{linked}" --path a'],
    ["uvx --directory", 'uvx --directory $"{linked}" git-filter-repo --path a'],
    ["uv run --directory=", 'uv run --directory=$"{linked}" git-filter-repo --path a'],
    ["uvx --project", 'uvx --project $"{linked}" git-filter-repo --path a'],
    ["UV_WORKING_DIR", 'UV_WORKING_DIR=$"{linked}" uvx git-filter-repo --path a'],
    ["UV_PROJECT", 'UV_PROJECT=$"{linked}" uvx git-filter-repo --path a'],
  ])("refuses a locale-quoted %s operand even when it names a linked worktree", (_name, command) => {
    for (const cwd of ["linked", "canonical", "clone"]) expect(run(command, cwd)?.guard).toBe("history-rewrite")
  })

  test("refuses a locale string in a canonical checkout", () => {
    expect(run('git filter-branch --env-filter $"true"', "canonical")?.guard).toBe("history-rewrite")
  })

  test("still allows a plain quoted operand and a locale string outside a rewrite", () => {
    expect(run('git -C "{linked}" filter-branch --env-filter true', "canonical")).toBeUndefined()
    expect(run('git -C "{canonical}" status', "canonical")).toBeUndefined()
  })
})

describe("an assignment-only command has no program word", () => {
  test.each([
    ["a double-quote in single quotes", `needle='$"'; echo ok`],
    ["a dollar-quote in double quotes", `needle="a\\$'b"; echo ok`],
    ["two assignments", `a='$"' b='$'"'"'x'; echo ok`],
  ])("passes literal %s data in everywhere", (_name, command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
  })

  test("still refuses a quoted program word that follows an assignment", () => {
    expect(run(`needle=1; $'ec\\150o' ok`, "linked")?.guard).toBe("history-rewrite")
  })
})

describe("runners that take arguments from stdin are judged by where they run", () => {
  // The gate only reads the text; none of these commands runs.
  const stdin = "printf 'update-ref -d refs/heads/main' |"
  test.each([
    ["xargs with a visible absolute -C", `${stdin} xargs git -C {canonical}`],
    ["xargs with a visible relative -C", `${stdin} xargs git -C ../canonical`],
    ["parallel with a visible -C", "parallel git -C {canonical} update-ref -d ::: refs/heads/main"],
    ["find -exec ... {} + with a visible -C", "find . -exec git -C {canonical} update-ref -d refs/heads/main {} +"],
    ["find -exec ... ; with a visible -C", "find . -exec git -C {canonical} update-ref -d refs/heads/main \\;"],
    ["xargs of uvx with a visible --directory", "printf x | xargs uvx --directory {canonical} git-filter-repo"],
    ["xargs of git-filter-repo with a visible --target", "printf x | xargs git-filter-repo --target {canonical}"],
  ])("refuses %s from a linked worktree", (_name, command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
  })

  test.each([
    ["xargs", `${stdin} xargs git -C .`],
    ["xargs without a visible directory", `${stdin} xargs git`],
    ["xargs of update-ref, whose -d stdin could add", "printf x | xargs git update-ref"],
    ["parallel of update-ref", "parallel git update-ref -d ::: refs/heads/main"],
    ["xargs of a launcher", "printf x | xargs uvx git-filter-repo"],
    ["xargs of an unreadable launcher program", "printf x | xargs uvx"],
  ])("refuses %s from a canonical checkout", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  // Stdin supplies the subcommand, -C, --git-dir or --target, so no location can be judged: refused everywhere.
  test.each([
    ["stdin that supplies -C and the subcommand", "printf -- '-C ../canonical update-ref -d refs/heads/main' | xargs git"],
    ["stdin that supplies --git-dir", "printf -- '--git-dir=../canonical/.git update-ref -d refs/heads/main' | xargs git"],
    ["xargs git with only a global flag", "printf x | xargs git --no-pager"],
    ["xargs git with a visible -C and no subcommand", "printf x | xargs git -C {linked}"],
    ["parallel with the subcommand substituted", "parallel git ::: '-C ../canonical update-ref -d refs/heads/main'"],
    ["find -exec with the subcommand substituted", "find . -exec git {} +"],
    ["xargs git-filter-repo, whose --target can come from stdin", "printf -- '--target ../canonical' | xargs git-filter-repo"],
    ["xargs of uvx git-filter-repo", "printf -- '--target ../canonical' | xargs uvx git-filter-repo"],
    ["xargs of a launcher with an unreadable program", "printf x | xargs uvx"],
  ])("refuses %s in every location", (_name, command) => {
    for (const cwd of ["canonical", "linked", "clone"]) {
      const refusal = run(command, cwd)
      expect(refusal?.guard).toBe("history-rewrite")
      expect(refusal?.reason).toContain("stdin")
    }
  })

  test.each([
    ["branch", "printf -- '-D main' | xargs git branch"],
    ["tag", "printf -- '-d v1' | xargs git tag"],
    ["push", "printf -- '--delete origin main' | xargs git push"],
    ["reflog", "xargs git reflog"],
    ["symbolic-ref", "xargs git symbolic-ref"],
    ["reset", "xargs git reset"],
    ["checkout", "xargs git checkout"],
  ])("refuses a ref-mutating xargs git %s in a canonical checkout, where stdin could change refs", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  // Only the program a runner executes counts: a word such as `git` among its arguments is data.
  test.each([
    "find . -type f -exec grep -l git {} +",
    "find . -type f -execdir grep -l git {} \\;",
    "parallel echo git ::: a",
    "parallel grep -l uvx ::: a",
    "xargs -I{} grep git {}",
    "printf x | xargs -n1 grep -l git",
    "printf x | xargs -P 4 -d '\\n' grep git-filter-repo",
  ])("leaves a runner whose program is something else alone everywhere: %s", (command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
  })

  test.each([
    ["find -exec after other tests", "find . -type f -name x -exec git {} +"],
    ["find -execdir git", "find . -execdir git {} \\;"],
    ["parallel with options", "parallel -j4 --colsep ',' git ::: a"],
    ["parallel after --", "parallel -- git ::: a"],
    ["xargs with options", "printf x | xargs -n1 -P 2 git"],
    ["parallel with an option this reader does not know, then git", "parallel --weird-option git ::: a"],
  ])("still refuses %s in every location", (_name, command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)?.guard).toBe("history-rewrite")
  })

  // parallel has no option-arity table here: with any option, a later tool or wrapper word makes the line unreadable.
  test.each([
    ["--link", "parallel --link git reset --soft ::: HEAD~1"],
    ["--shuf", "parallel --shuf git reset --soft ::: HEAD~1"],
    ["--halt now,fail=1", "parallel --halt now,fail=1 git reset --soft ::: HEAD~1"],
    ["-j4 with git among the arguments (accepted cost)", "parallel -j4 echo git ::: a b"],
    ["--colsep with git among the arguments (accepted cost)", "parallel --colsep ',' echo git ::: a"],
    ["an option then a wrapper", "parallel -j4 env git reset --soft ::: HEAD~1"],
    ["an option then a launcher", "parallel -j4 uvx git-filter-repo ::: a"],
  ])("refuses parallel %s in every location", (_name, command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)?.guard).toBe("history-rewrite")
  })

  test.each([
    ["an option value that is the separator", "parallel --colsep ::: git reset --soft ::: HEAD~1"],
    ["the separator as a value of -d", "parallel -d ::: git reset --soft ::: HEAD~1"],
    ["a tool after a second separator group", "parallel -j4 echo ::: a :::: git reset --soft"],
  ])("refuses parallel with %s in every location", (_name, command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)?.guard).toBe("history-rewrite")
  })

  // find: words inside an action are its data, up to the action's terminator.
  test("a second -exec inside an action's arguments is data, not a new action", () => {
    for (const cwd of ["canonical", "linked", "clone"])
      expect(run("find . -prune -exec echo -exec env git {} \\;", cwd)).toBeUndefined()
  })

  test.each([
    "find . -exec echo {} \\; -exec git branch -D main \\;",
    "find . -exec echo {} + -exec git branch -D main {} +",
    "find . -exec echo {} ';' -execdir env git update-ref -d refs/heads/main {} +",
  ])("still refuses a real second action in a canonical checkout: %s", (command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  test.each(["parallel -j4 grep foo ::: a", "parallel --link echo ::: a b", "parallel echo git ::: a", "parallel grep -l git ::: a"])(
    "lets parallel with no tool before the inputs through everywhere: %s",
    (command) => {
      for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
    },
  )

  // Wrappers are followed like at the top level. The gate only reads the text; none of these runs.
  test.each([
    ["find -exec env git reset", "find . -prune -exec env git reset --soft HEAD~1 ';'"],
    ["find -exec env git reset with an escaped terminator", "find . -prune -exec env git reset --soft HEAD~1 \\;"],
    ["find -execdir nice git branch", "find . -execdir nice -n 5 git branch -D main {} +"],
    ["find -exec sudo git update-ref", "find . -exec sudo git update-ref -d refs/heads/main {} +"],
    ["xargs env git branch", "xargs env git branch -D main"],
    ["xargs env after stdin", "printf main | xargs env git branch -D"],
    ["parallel env git", "parallel env git branch -D ::: main"],
    ["parallel timeout git", "parallel timeout 5 git branch -D ::: main"],
  ])("refuses %s in a canonical checkout", (_name, command) => {
    expect(run(command, "canonical")?.guard).toBe("history-rewrite")
  })

  test.each([
    ["find -exec env -C", "find . -exec env -C {canonical} git branch -D main {} +"],
    ["xargs env -C", "xargs env -C {canonical} git branch -D main"],
    ["find -exec env UV_WORKING_DIR", "find . -exec env UV_WORKING_DIR={canonical} uvx git-filter-repo {} +"],
  ])("keeps a wrapper's directory uncertainty: %s is refused from a linked worktree", (_name, command) => {
    expect(run(command, "linked")?.guard).toBe("history-rewrite")
  })

  test.each([
    "find . -type f -exec env grep git {} +",
    "find . -exec nice grep -l git {} +",
    "xargs env grep git",
    "parallel env echo git ::: a",
  ])("leaves a wrapped program that is not git alone everywhere: %s", (command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
  })

  test("an unknown parallel option passes when no git or launcher follows it", () => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run("parallel --weird-option echo ::: a", cwd)).toBeUndefined()
  })

  test("a ref-mutating subcommand run by find -exec is still judged by location", () => {
    expect(run("find . -exec git branch -D main \\;", "canonical")?.guard).toBe("history-rewrite")
    expect(run("find . -exec git branch -D main \\;", "linked")).toBeUndefined()
  })

  // A fixed read-only subcommand cannot be completed into a rewrite by stdin arguments.
  test.each([
    ["xargs git status", "xargs git status"],
    ["xargs git log", "printf x | xargs git log --oneline"],
    ["parallel git status", "parallel git status ::: a"],
    ["find -exec git status", "find . -exec git status \\;"],
    ["xargs git add", "git ls-files | xargs git add"],
    ["xargs git diff", "xargs git diff --stat"],
    ["xargs git config", "xargs git config --get"],
  ])("lets %s through everywhere", (_name, command) => {
    for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
  })

  test("a visible -C into a linked worktree passes from a canonical checkout and a linked worktree", () => {
    for (const cwd of ["canonical", "linked"]) expect(run("printf x | xargs git -C {linked} status", cwd)).toBeUndefined()
  })

  test.each(["printf x | xargs echo", "printf x | xargs", "xargs -n1 echo a", "find . -exec ls {} +", "parallel echo ::: a"])(
    "leaves a runner that starts something else alone everywhere: %s",
    (command) => {
      for (const cwd of ["canonical", "linked", "clone"]) expect(run(command, cwd)).toBeUndefined()
    },
  )
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
