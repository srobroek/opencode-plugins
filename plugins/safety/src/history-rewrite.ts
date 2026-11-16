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
import { dirname, join, resolve } from "node:path"
import { base, type Command, gitInvocation, positionals } from "./shell.ts"

const PREFIX = "Blocked by safety (history-rewrite-guard)"
const FILTER_REPO_NAME = /^git[-_]filter[-_]repo(?:\.py)?$/
const LAUNCHERS: ReadonlySet<string> = new Set(["uvx", "uv", "pipx", "python", "python3", "pipenv"])
const UPDATE_REF_VALUED: ReadonlySet<string> = new Set(["-m"])
const ZERO_OID = /^0{40,64}$/

/** A word with a `$` or backtick: its value is unknown until the shell expands it. */
const dynamic = (word: string): boolean => /[$`]/.test(word)

type FilterRepo = { args: string[]; chdirs: string[] }

/** `git filter-repo`, `git-filter-repo`, or either behind `uvx`, `uv`, `pipx` or `python -m`. */
function filterRepo(command: Command): FilterRepo | undefined {
  const name = base(command.argv[0])
  if (FILTER_REPO_NAME.test(name)) return { args: command.argv.slice(1), chdirs: [] }
  const git = gitInvocation(command.argv)
  if (git?.subcommand === "filter-repo") return { args: git.args, chdirs: git.chdirs }
  if (!LAUNCHERS.has(name)) return undefined
  const at = command.argv.findIndex((word, i) => i > 0 && FILTER_REPO_NAME.test(base(word)))
  return at < 0 ? undefined : { args: command.argv.slice(at + 1), chdirs: [] }
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
  for (const command of commands) {
    const git = gitInvocation(command.argv)
    const chdirs = (git?.chdirs ?? []).filter((dir) => !dynamic(dir))
    const dir = chdirs.reduce((at, chdir) => resolve(at, chdir), cwd)
    const checkout = (target: string): string | undefined => canonicalCheckout(target, tempRoots)

    const rewrite = filterRepo(command)
    if (rewrite !== undefined) {
      const text = `\`${command.argv.slice(0, 4).join(" ")}\``
      if (rewrite.args.some((arg) => arg === "--force" || arg === "-f"))
        return `${PREFIX}: refused ${text} with --force. filter-repo --force overwrites the repository's refs and history in the directory it runs in, wherever that is. Run it without --force in a fresh temp clone with the tool's workdir set there; a fresh clone needs no --force.`
      const target = optionValue(rewrite.args, "--target")
      const targetDir = target === undefined || dynamic(target) ? dir : resolve(dir, target)
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
      const [ref, value] = positionals(git.args, UPDATE_REF_VALUED)
      const zero = value !== undefined && ZERO_OID.test(value)
      if ((deleting || zero) && ref?.startsWith("refs/heads/")) return refused(`\`git update-ref\` deleting ${ref}`, root)
    }
  }
  return undefined
}
