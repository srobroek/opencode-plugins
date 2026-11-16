/**
 * Refuse history-rewriting commands that would run in place in a canonical checkout.
 *
 * `git filter-repo` writes to the current directory unless `--target` says otherwise, so a run
 * meant for a temp clone but started from the main checkout rewrote its `main` and every tag.
 * `git filter-branch`, `git replace` and a branch-deleting `git update-ref` do the same in place.
 * A canonical checkout is a git work tree whose `.git` is a directory, outside any temp folder.
 * Linked worktrees (`.git` is a file) and temp clones are fine, except for `filter-repo --force`,
 * which overwrites the repository's refs wherever it runs.
 *
 * The threat model is an agent that picked the wrong directory, not one hiding the command.
 */

import { realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { base, type Command, gitInvocation, positionals } from "./shell.ts"

const PREFIX = "Blocked by safety (history-rewrite-guard)"
const FILTER_REPO_NAME = /^git[-_]filter[-_]repo(?:\.py)?$/
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
])
const UPDATE_REF_VALUED: ReadonlySet<string> = new Set(["-m"])
const ZERO_OID = /^0{40,64}$/

/** A word with a `$` or backtick: its value is unknown until the shell expands it. */
const dynamic = (word: string): boolean => /[$`]/.test(word) || word.startsWith("~")

type FilterRepo = { args: string[]; chdirs: string[] }

/** The words after the program a launcher runs: `uvx`, `uv tool run`, `uv run`, `pipx run`, `python`. */
function launched(argv: readonly string[]): { program: string; args: string[] } | undefined {
  const name = base(argv[0])
  let start: number
  if (name === "uvx") start = 1
  else if (name === "uv") start = argv[1] === "tool" && argv[2] === "run" ? 3 : argv[1] === "run" ? 2 : -1
  else if (name === "pipx") start = argv[1] === "run" ? 2 : -1
  else if (/^python3?(?:\.\d+)?$/.test(name)) start = 1
  else return undefined
  if (start < 0) return undefined
  for (let i = start; i < argv.length; i++) {
    const word = argv[i] as string
    if (name.startsWith("python") && word === "-m") {
      const module = argv[i + 1]
      return module === undefined ? undefined : { program: module, args: argv.slice(i + 2) }
    }
    if (name.startsWith("python") && word === "-c") return undefined
    if (word.startsWith("-")) {
      if (LAUNCHER_VALUED.has(word)) i++
      continue
    }
    return { program: word, args: argv.slice(i + 1) }
  }
  return undefined
}

/** `git filter-repo`, `git-filter-repo`, or either run through a launcher (a version qualifier is ignored). */
function filterRepo(command: Command): FilterRepo | undefined {
  const name = base(command.argv[0])
  if (FILTER_REPO_NAME.test(name)) return { args: command.argv.slice(1), chdirs: [] }
  const git = gitInvocation(command.argv)
  if (git?.subcommand === "filter-repo") return { args: git.args, chdirs: git.chdirs }
  const run = launched(command.argv)
  if (run === undefined) return undefined
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

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The folders whose clones are disposable: the OS temp directory, which holds OpenCode's. */
export function defaultTempRoots(): string[] {
  return [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].map(realOrSelf)
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)

/** The canonical checkout `dir` sits in, or `undefined` for a linked worktree, a temp clone or no repository. */
function canonicalCheckout(dir: string, tempRoots: readonly string[]): string | undefined {
  let at = dir
  for (;;) {
    try {
      at = realpathSync(at)
      break
    } catch {
      const parent = dirname(at)
      if (parent === at) return undefined
      at = parent
    }
  }
  if (tempRoots.some((root) => within(at, realOrSelf(root)))) return undefined
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

/**
 * Step into `dir` from the real directory `at`, one component at a time, resolving each symlink
 * before a later `..` is applied (`link/..` leaves the link's target, not the link's parent).
 * A component that cannot be resolved leaves the last resolved directory.
 */
function enter(at: string, dir: string): string {
  let here = dir.startsWith("/") ? "/" : at
  for (const part of dir.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      here = dirname(here)
      continue
    }
    try {
      here = realpathSync(join(here, part))
    } catch {
      return here
    }
  }
  return here
}

/**
 * What a literal `git update-ref --stdin` transaction deletes: a `refs/heads/` ref, or `"unreadable"`
 * when the commands do not come from a literal here-document or here-string (a pipe, a file, `-z`).
 */
function stdinDeletes(command: Command, args: readonly string[]): string | "unreadable" | undefined {
  if (args.includes("-z")) return "unreadable"
  const sources: string[] = []
  for (const document of command.hereDocuments) {
    if (!document.quoted && /[$`]/.test(document.body)) return "unreadable"
    sources.push(document.body)
  }
  for (const redirect of command.redirects) {
    if (redirect.hereString !== true) continue
    if (redirect.expands) return "unreadable"
    sources.push(redirect.value)
  }
  if (sources.length === 0) return "unreadable"
  for (const line of sources.join("\n").split("\n")) {
    const [verb, ref, value] = line.trim().split(/\s+/)
    if (ref?.startsWith("refs/heads/") !== true) continue
    if (verb === "delete" || (verb === "update" && value !== undefined && ZERO_OID.test(value))) return ref
  }
  return undefined
}

const refused = (what: string, where: string): string =>
  `${PREFIX}: refused ${what}. ${where} is a canonical checkout (its .git is a directory), and this command rewrites or deletes history in place, which cannot be undone from the work tree. Clone the repository into a temp directory (\`git clone <repo> "$TMPDIR/<name>"\`) and run the command there with the tool's workdir set to the clone.`

/**
 * Why a command in `commands` is refused, or `undefined`. `cwd` is the directory the call runs
 * in, after any leading `cd`. `tempRoots` replaces the default temp folders (tests).
 */
export function historyRewrite(
  commands: readonly Command[],
  cwd: string,
  tempRoots: readonly string[] = defaultTempRoots(),
): string | undefined {
  // The plugin applies an unquoted leading `cd` itself; a quoted literal one is read here.
  let start = realOrSelf(cwd)
  const first = commands[0]
  if (first?.context === "top" && first.argv[0] === "cd" && first.argv.length === 2 && first.words?.[1]?.quoted === true) {
    const operand = first.argv[1] as string
    if (!dynamic(operand)) start = enter(start, operand)
  }
  for (const command of commands) {
    const git = gitInvocation(command.argv)
    const chdirs = (git?.chdirs ?? []).filter((dir) => !dynamic(dir))
    const dir = chdirs.reduce(enter, start)
    const checkout = (target: string): string | undefined => canonicalCheckout(target, tempRoots)

    const rewrite = filterRepo(command)
    if (rewrite !== undefined) {
      const text = `\`${command.argv.slice(0, 4).join(" ")}\``
      if (rewrite.args.some((arg) => arg === "--force" || arg === "-f"))
        return `${PREFIX}: refused ${text} with --force. filter-repo --force overwrites the repository's refs and history in the directory it runs in, wherever that is. Run it without --force in a fresh temp clone with the tool's workdir set there; a fresh clone needs no --force.`
      const target = optionValue(rewrite.args, "--target")
      const targetDir = target === undefined || dynamic(target) ? dir : enter(dir, target)
      const root = checkout(targetDir)
      if (root !== undefined) return refused(text, root)
      continue
    }
    if (git === undefined) continue
    const root = checkout(dir)
    if (root === undefined) continue
    const text = `\`git ${git.subcommand}\``
    if (git.subcommand === "filter-branch") return refused(text, root)
    if (git.subcommand === "replace") {
      const reads = git.args.some((arg) => arg === "-l" || arg === "--list" || arg.startsWith("--format"))
      if (!reads) return refused(text, root)
    }
    if (git.subcommand === "update-ref") {
      const deleting = git.args.includes("-d") || git.args.includes("--delete")
      if (git.args.includes("--stdin")) {
        const deleted = stdinDeletes(command, git.args)
        if (deleted === "unreadable")
          return refused("`git update-ref --stdin` (its transaction does not come from a literal here-document, so deletions cannot be ruled out)", root)
        if (deleted !== undefined) return refused(`\`git update-ref --stdin\` deleting ${deleted}`, root)
      }
      const [ref, value] = positionals(git.args, UPDATE_REF_VALUED)
      const zero = value !== undefined && ZERO_OID.test(value)
      if ((deleting || zero) && ref?.startsWith("refs/heads/")) return refused(`\`git update-ref\` deleting ${ref}`, root)
    }
  }
  return undefined
}
