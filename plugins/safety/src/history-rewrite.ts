/**
 * Refuse history-rewriting commands unless they provably run in a linked worktree or temp clone.
 *
 * `git filter-repo` writes to the current directory unless `--target` says otherwise, so a run
 * meant for a temp clone but started from the main checkout rewrote its `main` and every tag.
 * `git filter-branch`, `git replace` and a branch-deleting `git update-ref` do the same in place.
 *
 * The guard fails closed. A rewriting command passes only when its directory resolves to a linked
 * worktree (`.git` is a file) or a temp clone (under the OS temp folder), by BOTH the logical rule
 * (shell `cd` semantics: `..` removes the previous path component) and the physical rule (each
 * symlink resolved before the next component). Anything the guard cannot settle is refused:
 * expansions, `~`, `cd -`, `pushd`, a `cd` whose effect on later commands depends on shell
 * structure, a symlink where the two rules disagree, a step that does not resolve, and an
 * `update-ref --stdin` transaction that is not fully readable. A false refusal costs one retry in
 * a temp clone. `filter-repo --force` is refused everywhere. A directory outside any git
 * repository passes: there is nothing to rewrite.
 */

import { realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { base, type Command, type GitInvocation, gitInvocation, positionals } from "./shell.ts"

const PREFIX = "Blocked by safety (history-rewrite-guard)"
const FILTER_REPO_NAME = /^git[-_]filter[-_]repo(?:\.py)?$/
const MENTIONS_FILTER_REPO = /git[-_]filter[-_]repo/
const UPDATE_REF_VALUED: ReadonlySet<string> = new Set(["-m"])
const ZERO_OID = /^0{40,64}$/

/** Launcher options that take the next word as their value, so it is not the program. */
const LAUNCHER_VALUED: ReadonlySet<string> = new Set([
  "--from",
  "--with",
  "--with-requirements",
  "--with-editable",
  "-p",
  "--python",
  "--index",
  "--index-url",
  "-i",
  "--extra-index-url",
  "--default-index",
  "--constraint",
  "-c",
  "--env-file",
  "--directory",
  "--project",
  "--config-file",
  "--cache-dir",
  "--spec",
  "--pip-args",
  "--suffix",
  "-W",
  "-X",
])
const UV_NON_RUN: ReadonlySet<string> = new Set([
  "pip",
  "add",
  "remove",
  "sync",
  "lock",
  "venv",
  "init",
  "build",
  "publish",
  "python",
  "cache",
  "self",
  "version",
  "export",
  "tree",
  "help",
])
const PIPX_NON_RUN: ReadonlySet<string> = new Set([
  "install",
  "uninstall",
  "uninstall-all",
  "list",
  "inject",
  "uninject",
  "upgrade",
  "upgrade-all",
  "reinstall",
  "reinstall-all",
  "ensurepath",
  "environment",
  "completions",
  "runpip",
  "pin",
  "unpin",
  "interpreter",
  "upgrade-shared",
])
const PIPENV_NON_RUN: ReadonlySet<string> = new Set([
  "install",
  "uninstall",
  "lock",
  "sync",
  "update",
  "shell",
  "graph",
  "check",
  "clean",
  "requirements",
  "verify",
  "scripts",
  "open",
])

/** A word whose value is unknown until the shell expands it. */
const dynamic = (word: string): boolean => /[$`]/.test(word) || word.startsWith("~")

type FilterRepo = { args: string[]; chdirs: string[] }
type Launched = { program: string; args: string[] } | "not-run" | "unparsed"

/** Index of the first word at or after `at` that is not an option (valued ones skip their value). */
function skipOptions(argv: readonly string[], at: number, valued: ReadonlySet<string>): number {
  let i = at
  while (i < argv.length && (argv[i] as string).startsWith("-")) i += valued.has(argv[i] as string) ? 2 : 1
  return i
}

/** The program a launcher (`uvx`, `uv`, `pipx`, `pipenv`, `python`) runs and its arguments. */
function launched(argv: readonly string[]): Launched | undefined {
  const name = base(argv[0])
  let start: number
  if (name === "uvx") start = 1
  else if (name === "uv" || name === "pipx" || name === "pipenv") {
    const at = skipOptions(argv, 1, name === "uv" ? LAUNCHER_VALUED : new Set())
    const sub = argv[at]
    if (name === "uv" && sub === "tool") {
      if (argv[at + 1] === "run") start = at + 2
      else return argv[at + 1] === undefined || argv[at + 1]?.startsWith("-") ? "unparsed" : "not-run"
    } else if (sub === "run") start = at + 1
    else if (sub === undefined) return "unparsed"
    else {
      const known = name === "uv" ? UV_NON_RUN : name === "pipx" ? PIPX_NON_RUN : PIPENV_NON_RUN
      return known.has(sub) ? "not-run" : "unparsed"
    }
  } else if (/^python3?(?:\.\d+)?$/.test(name)) start = 1
  else return undefined
  const python = name.startsWith("python")
  for (let i = start; i < argv.length; i++) {
    const word = argv[i] as string
    if (python && word === "-m") {
      const module = argv[i + 1]
      return module === undefined ? "unparsed" : { program: module, args: argv.slice(i + 2) }
    }
    if (python && word === "-c") return "not-run"
    if (word.startsWith("-")) {
      if (LAUNCHER_VALUED.has(word)) i++
      continue
    }
    return { program: word, args: argv.slice(i + 1) }
  }
  return "unparsed"
}

/** `git filter-repo`, `git-filter-repo`, or either run through a launcher; `"uncertain"` when it cannot be told. */
function filterRepo(command: Command): FilterRepo | "uncertain" | undefined {
  const name = base(command.argv[0])
  if (FILTER_REPO_NAME.test(name)) return { args: command.argv.slice(1), chdirs: [] }
  const git = gitInvocation(command.argv)
  if (git?.subcommand === "filter-repo") return { args: git.args, chdirs: git.chdirs }
  const run = launched(command.argv)
  if (run === undefined || run === "not-run") return undefined
  if (run === "unparsed") return command.argv.some((word) => MENTIONS_FILTER_REPO.test(word)) ? "uncertain" : undefined
  // `git-filter-repo@2.47.0`, `git-filter-repo==2.47`, `git-filter-repo[extra]`: the executable is the name.
  const program = base(run.program.replace(/[@=<>~![].*$/, ""))
  return FILTER_REPO_NAME.test(program) ? { args: run.args, chdirs: [] } : undefined
}

/** The value of `--name value` or `--name=value`. */
function optionValue(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === name) return args[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const realOrSelf = (path: string): string => realOrUndefined(path) ?? path

/** The folders whose clones are disposable: the OS temp directory, which holds OpenCode's. */
export function defaultTempRoots(): string[] {
  return [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].map(realOrSelf)
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)

/** A real directory and the lexical path the shell would show for it. */
type Track = { logical: string; physical: string }

/** Step into `operand` physically: each symlink is resolved before a later `..`. `undefined` when a component is missing. */
function enter(at: string, operand: string): string | undefined {
  let here = operand.startsWith("/") ? "/" : at
  for (const part of operand.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      here = dirname(here)
      continue
    }
    const next = realOrUndefined(join(here, part))
    if (next === undefined) return undefined
    here = next
  }
  return here
}

/**
 * Apply one directory change. `shell` follows `cd`'s logical rule (the lexical `..`); a physical
 * `cd -P` and git's `-C` follow the symlinks. `undefined` when the two rules disagree about the
 * real directory or a component does not resolve: the step is then uncertain.
 */
function step(at: Track, operand: string, mode: "shell" | "physical"): Track | undefined {
  const physical = enter(at.physical, operand)
  if (physical === undefined) return undefined
  const logicalBase = mode === "shell" ? at.logical : at.physical
  const logical = resolve(logicalBase, operand)
  if (realOrUndefined(logical) !== physical) return undefined
  return { logical: mode === "shell" ? logical : physical, physical }
}

type Where = { dir: string } | { uncertain: string }

/** `cd`'s operand and mode, or why it is uncertain. */
function cdOperand(argv: readonly string[]): { operand: string; mode: "shell" | "physical" } | string {
  let mode: "shell" | "physical" = "shell"
  let i = 1
  for (; i < argv.length && (argv[i] as string).startsWith("-") && argv[i] !== "-"; i++) {
    if (argv[i] === "--") {
      i++
      break
    }
    if (argv[i] === "-P") mode = "physical"
    else if (argv[i] === "-L") mode = "shell"
  }
  const operand = argv[i]
  if (operand === undefined || operand === "-") return "a cd without a directory, or `cd -`"
  if (argv.length > i + 1) return "a cd with extra arguments"
  if (dynamic(operand)) return "a cd to an expanded directory"
  return { operand, mode }
}

/**
 * The directory `command` runs in: the call's directory, every `cd` that provably reaches it, then
 * its own `-C` and `--target` changes. A `cd` in a subshell, a pipeline, the background or a separate
 * process does not reach it; one in a branch, after `||`, through `eval`, or via `pushd`/`popd`
 * might, so the result is uncertain.
 */
function runDirectory(
  commands: readonly Command[],
  command: Command,
  cwd: string,
  moves: readonly string[],
): Where {
  const real = realOrUndefined(cwd)
  if (real === undefined) return { uncertain: "the working directory cannot be resolved" }
  let track: Track = { logical: resolve(cwd), physical: real }
  const pipelineSize = new Map<number, number>()
  for (const other of commands) pipelineSize.set(other.pipeline, (pipelineSize.get(other.pipeline) ?? 0) + 1)
  for (const other of commands) {
    if (other.index >= command.index) break
    const name = base(other.argv[0])
    if (name !== "cd" && name !== "pushd" && name !== "popd") continue
    const detached = other.subshell || other.background || (pipelineSize.get(other.pipeline) ?? 1) > 1
    if (detached) continue
    if (other.scope !== command.scope) {
      // A separate process (a script, a substitution) cannot change this shell's directory; `eval` can.
      if (["shell", "substitution", "here-document", "xargs"].includes(other.context)) continue
      return { uncertain: "a directory change in another scope may reach it" }
    }
    if (name !== "cd") return { uncertain: `\`${name}\` changes the directory stack` }
    if (other.compound || other.orList) return { uncertain: "a cd in a branch, loop or after || may not run" }
    const read = cdOperand(other.argv)
    if (typeof read === "string") return { uncertain: read }
    const next = step(track, read.operand, read.mode)
    if (next === undefined) return { uncertain: `\`cd ${read.operand}\` does not resolve the same way logically and physically` }
    track = next
  }
  for (const move of moves) {
    if (dynamic(move)) return { uncertain: "a -C or --target directory is expanded by the shell" }
    const next = step(track, move, "physical")
    if (next === undefined) return { uncertain: `\`${move}\` does not resolve the same way logically and physically` }
    track = next
  }
  return { dir: track.physical }
}

/** The repository root when `dir` is a canonical checkout; `undefined` for a linked worktree, a temp clone or no repository. */
function canonicalCheckout(dir: string, tempRoots: readonly string[]): string | undefined {
  if (tempRoots.some((root) => within(dir, realOrSelf(root)))) return undefined
  let at = dir
  for (;;) {
    try {
      return statSync(join(at, ".git")).isDirectory() ? at : undefined
    } catch {
      // No .git here; look in the parent.
    }
    const parent = dirname(at)
    if (parent === at) return undefined
    at = parent
  }
}

const isBranchRef = (ref: string | undefined): boolean => ref === "HEAD" || ref?.startsWith("refs/heads/") === true

/**
 * What a `git update-ref --stdin` transaction deletes, read from a literal here-document or
 * here-string. Anything not fully readable (a pipe, a file, `-z`, an expansion, a quoted field)
 * counts as a possible branch delete, as does an `update` with an empty new value.
 */
function stdinRewrite(command: Command, args: readonly string[]): string | undefined {
  const unreadable = "`git update-ref --stdin` (its transaction cannot be fully read, so a branch delete cannot be ruled out)"
  if (args.includes("-z")) return unreadable
  const sources: string[] = []
  for (const document of command.hereDocuments) {
    if (!document.quoted && /[$`]/.test(document.body)) return unreadable
    sources.push(document.body)
  }
  for (const redirect of command.redirects) {
    if (redirect.hereString !== true) continue
    if (redirect.expands) return unreadable
    sources.push(redirect.value)
  }
  if (sources.length === 0) return unreadable
  for (const line of sources.join("\n").split("\n")) {
    if (line.includes('"')) return unreadable
    const [verb, ref, value] = line.trim().split(" ")
    if (!isBranchRef(ref)) continue
    if (verb === "delete" || (verb === "update" && (value === undefined || value === "" || ZERO_OID.test(value))))
      return `\`git update-ref --stdin\` deleting ${ref}`
  }
  return undefined
}

/** Why a `git update-ref` deletes a branch ref (or might), or `undefined`. */
function updateRefRewrite(command: Command, git: GitInvocation): string | undefined {
  if (git.args.includes("--stdin")) return stdinRewrite(command, git.args)
  const deleting = git.args.includes("-d") || git.args.includes("--delete")
  const [ref, value] = positionals(git.args, UPDATE_REF_VALUED)
  const zero = value !== undefined && (value === "" || ZERO_OID.test(value))
  if (!deleting && !zero) return undefined
  if (ref === undefined || dynamic(ref)) return "`git update-ref` deleting a ref it cannot read"
  return isBranchRef(ref) ? `\`git update-ref\` deleting ${ref}` : undefined
}

const GUIDANCE =
  "Clone the repository into a temp directory (`git clone <repo> \"$TMPDIR/<name>\"`) and run the command there with the tool's workdir set to the clone; a false refusal costs one retry."

const refused = (what: string, root: string): string =>
  `${PREFIX}: refused ${what}. ${root} is a canonical checkout (its .git is a directory), and this command rewrites or deletes history in place, which cannot be undone from the work tree. ${GUIDANCE}`

const uncertain = (what: string, why: string): string =>
  `${PREFIX}: refused ${what}. It rewrites or deletes history in place, and the guard cannot tell with certainty that it runs in a linked worktree or temp clone (${why}). ${GUIDANCE}`

/**
 * Why a command in `commands` is refused, or `undefined`. `cwd` is the directory the tool call
 * starts in, before any `cd`. `tempRoots` replaces the default temp folders (tests).
 */
export function historyRewrite(
  commands: readonly Command[],
  cwd: string,
  tempRoots: readonly string[] = defaultTempRoots(),
): string | undefined {
  const verdict = (command: Command, what: string, moves: string[]): string | undefined => {
    const where = runDirectory(commands, command, cwd, moves)
    if ("uncertain" in where) return uncertain(what, where.uncertain)
    const root = canonicalCheckout(where.dir, tempRoots)
    return root === undefined ? undefined : refused(what, root)
  }
  for (const command of commands) {
    const git = gitInvocation(command.argv)
    const text = `\`${command.argv.slice(0, 4).join(" ")}\``
    const rewrite = filterRepo(command)
    if (rewrite === "uncertain") return uncertain(text, "the launcher's command line could not be read")
    if (rewrite !== undefined) {
      if (rewrite.args.some((arg) => arg === "--force" || arg === "-f"))
        return `${PREFIX}: refused ${text} with --force. filter-repo --force overwrites the repository's refs and history in the directory it runs in, wherever that is. Run it without --force in a fresh temp clone with the tool's workdir set there; a fresh clone needs no --force.`
      const target = optionValue(rewrite.args, "--target")
      const moves = [...(git?.chdirs ?? []), ...(target === undefined ? [] : [target])]
      const reason = verdict(command, text, moves)
      if (reason !== undefined) return reason
      continue
    }
    if (git === undefined) continue
    let what: string | undefined
    if (git.subcommand === "filter-branch") what = `\`git ${git.subcommand}\``
    else if (git.subcommand === "replace") {
      const reads = git.args.some((arg) => arg === "-l" || arg === "--list" || arg.startsWith("--format"))
      if (!reads) what = `\`git ${git.subcommand}\``
    } else if (git.subcommand === "update-ref") what = updateRefRewrite(command, git)
    if (what === undefined) continue
    if (git.overridden || command.assignments.some((item) => /^GIT_(?:DIR|WORK_TREE)=/.test(item)))
      return uncertain(what, "git is pointed at a repository by --git-dir, --work-tree, GIT_DIR or GIT_WORK_TREE")
    const reason = verdict(command, what, git.chdirs)
    if (reason !== undefined) return reason
  }
  return undefined
}
