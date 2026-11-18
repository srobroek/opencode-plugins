/**
 * Refuse history-rewriting commands unless they provably run in a linked worktree or temp clone.
 *
 * `git filter-repo` writes to the current directory unless `--target` says otherwise, so a run
 * meant for a temp clone but started from the main checkout rewrote its `main` and every tag.
 * `git filter-branch`, `git replace` and a branch-deleting `git update-ref` do the same in place.
 *
 * The guard fails closed and models neither the shell nor git's repository selection. A rewriting
 * command is refused when the same shell command also contains anything that could change the
 * directory it runs in (`cd`, `pushd`, `popd`, `builtin`, `command`, `env`, a wrapper's
 * `-C`/`--chdir`, `git --exec-path`, a nested shell, `eval`, `source`, `xargs`, `exec`, a function
 * or alias) or select another repository (`--git-dir`, `--work-tree`, `--config-env`, `-c core.worktree`,
 * `-c core.bare`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY`), or when the session's own environment sets one of the `GIT_*` names
 * that select a repository. Otherwise only the tool call's workdir and `-C` (and filter-repo's
 * `--target`) are judged. The directory must resolve to a real directory the same way logically
 * and physically, and be a temp clone (under the OS temp folder) or a verified linked worktree. A false refusal costs one retry
 * in a temp clone. `filter-repo --force` is refused everywhere. A directory outside any git
 * repository passes: there is nothing to rewrite.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { commandWords, commandWrappers } from "@srobroek/opencode-lib"
import { base, type Command, type GitInvocation, gitInvocation, positionals, SHELLS } from "./shell.ts"

const PREFIX = "Blocked by safety (history-rewrite-guard)"
const FILTER_REPO_NAME = /^git[-_]filter[-_]repo(?:\.py)?$/
const MENTIONS_FILTER_REPO = /git[-_]filter[-_]repo/
const UPDATE_REF_VALUED: ReadonlySet<string> = new Set(["-m"])
const ZERO_OID = /^0{40,64}$/
const MAX_METADATA = 4096

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
/** Commands that change the directory, run other code, or rebind names, wherever they appear. */
const CONSTRUCTS: ReadonlySet<string> = new Set([
  "cd",
  "pushd",
  "popd",
  "eval",
  "source",
  ".",
  "xargs",
  "exec",
  "alias",
  "unalias",
  "function",
  "builtin",
  "command",
  "env",
])
/** `name()` or `function name`: a function definition. */
const FUNCTION_DEFINITION = /(?:^|[;&|{(\s])(?:function\s+[A-Za-z_][\w:.-]*|[A-Za-z_][\w:.-]*\s*\(\s*\))/

/** Options and variables that point git at a repository other than the one the directory implies. */
const REPOSITORY_SELECTION =
  /(?<![\w-])(?:--git-dir|--work-tree|--config-env)(?![\w-])|(?<![\w])GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY)(?![\w])|(?<![\w-])-c\s*['"]?core\.(?:worktree|bare)/i
/** The `GIT_*` names whose presence in the session's own environment already selects a repository. */
const INHERITED_SELECTION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const

/** A word whose value is unknown until the shell expands it. */
const dynamic = (word: string): boolean => /[$`]/.test(word) || word.startsWith("~")

/**
 * A directory operand the guard cannot take at face value. Besides `dynamic` words: the scanner drops
 * the quotes of `$'…'` but keeps its escapes (`$'\056\056'` is `..`), and the shell expands unquoted globs
 * (`[c]anonical`) and braces (`{a,b}`). Quoted glob characters are refused too: a false refusal costs one retry.
 */
const unreadable = (word: string): boolean => dynamic(word) || /[\\*?[{]/.test(word)

/**
 * Whether a word is spelled with ANSI-C (`$'…'`) or locale (`$"…"`) quoting. The guard never decodes
 * either: the scanner keeps the escapes of `$'…'` as written, and every decoder it could have would
 * have to match bash exactly (NUL truncation, `\c@`, per-fragment concatenation). Instead a line that
 * mixes such a word with git or a launcher is refused wherever it would run in a canonical checkout.
 * That also refuses an ordinary `git $'sta\164us'` there, a deliberate trade-off: this spelling is
 * extremely rare, and refusing it closes the whole class.
 */
const ansiQuoted = (command: Command): boolean =>
  command.words === undefined
    ? /\$['"]/.test(command.source)
    : command.words.some((word) => /\$['"]/.test(command.source.slice(word.start, word.end)))

const abbreviatesTarget = (arg: string): boolean => {
  const name = arg.split("=")[0] as string
  return name.length >= 3 && "--target".startsWith(name)
}

/**
 * Whether the command's program word (after wrappers) is spelled with `$'…'` or `$"…"` quoting. Such a
 * word is treated as a possible guarded program without asking which one: an escaped `/`, a NUL that
 * truncates, or a case-insensitive file system each defeat any name matcher. Such a word is refused
 * everywhere, even an escaped `echo`: nobody needs an escaped program name.
 */
const quotedProgram = (command: Command): boolean => {
  if (command.argv.length === 0) return false // an assignment-only command has no program word
  const word = command.words?.[0]
  return word === undefined
    ? command.argv[0]?.includes("\\") === true || /\$['"]/.test(command.source)
    : /\$['"]/.test(command.source.slice(word.start, word.end))
}

const LOCALE_REASON =
  'a `$"…"` locale string is translated by bash when a message catalog is active, so a directory operand written that way cannot be verified, wherever it points'

/** A command that could be git, git-filter-repo or a launcher of either (a quoted program word counts). */
const gitOrLauncher = (command: Command): boolean =>
  quotedProgram(command) ||
  FILTER_REPO_NAME.test(base(command.argv[0])) ||
  gitInvocation(command.argv) !== undefined ||
  launched(command.argv) !== undefined

type FilterRepo = { args: string[]; chdirs: string[]; projects: string[] }
type Launched = { program: string; args: string[]; chdirs: string[]; projects: string[] } | "not-run" | "unparsed"


/** Index of the first word at or after `at` that is not an option (valued ones skip their value). */
function skipOptions(argv: readonly string[], at: number, valued: ReadonlySet<string>): number {
  let i = at
  while (i < argv.length && (argv[i] as string).startsWith("-")) i += valued.has(argv[i] as string) ? 2 : 1
  return i
}

/**
 * uv's `--directory` (changes the working directory before running) and `--project` (names the
 * project directory) values in `argv[from, to)`. A missing value is `""`, which never resolves.
 */
function uvDirectories(argv: readonly string[], from: number, to: number): { chdirs: string[]; projects: string[] } {
  const found = { chdirs: [] as string[], projects: [] as string[] }
  for (let i = from; i < to; i++) {
    const word = argv[i] as string
    for (const [name, into] of [["--directory", found.chdirs], ["--project", found.projects]] as const) {
      if (word === name) into.push(argv[i + 1] ?? "")
      else if (word.startsWith(`${name}=`)) into.push(word.slice(name.length + 1))
    }
  }
  return found
}

/** uv's environment variables that name the directory it runs in or the project it uses. */
const UV_DIRECTORY_ENV = /(?<![\w])UV_(?:WORKING_DIR|PROJECT)(?![\w])/

/** Whether `command` could set `UV_WORKING_DIR` or `UV_PROJECT` for a later command (`X=…`, `export`, `declare -x`, `set -a`). */
function setsUvDirectory(command: Command): boolean {
  if (command.assignments.some((item) => UV_DIRECTORY_ENV.test(item.split("=")[0] as string))) return true
  if (command.argv.some((word) => UV_DIRECTORY_ENV.test(word))) return true
  return base(command.argv[0]) === "set" && command.argv.slice(1).some((word) => /^-[a-zA-Z]*a|^allexport$/.test(word))
}

/** The value of an inline `NAME=value` assignment (the last one wins), outer quotes removed, as a list of zero or one. */
function assigned(command: Command, name: string): string[] {
  const found = command.assignments.filter((item) => item.startsWith(`${name}=`)).at(-1)
  return found === undefined ? [] : [found.slice(name.length + 1).replace(/^(["'])(.*)\1$/s, "$2")]
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
      return module === undefined ? "unparsed" : { program: module, args: argv.slice(i + 2), chdirs: [], projects: [] }
    }
    if (python && word === "-c") return "not-run"
    if (word.startsWith("-")) {
      if (LAUNCHER_VALUED.has(word)) i++
      continue
    }
    const dirs = name === "uv" || name === "uvx" ? uvDirectories(argv, 1, i) : { chdirs: [], projects: [] }
    return { program: word, args: argv.slice(i + 1), ...dirs }
  }
  return "unparsed"
}

/** `git filter-repo`, `git-filter-repo`, or either run through a launcher; `"uncertain"` when it cannot be told. */
function filterRepo(command: Command): FilterRepo | "uncertain" | undefined {
  const name = base(command.argv[0])
  if (FILTER_REPO_NAME.test(name)) return { args: command.argv.slice(1), chdirs: [], projects: [] }
  const git = gitInvocation(command.argv)
  if (git?.subcommand === "filter-repo") return { args: git.args, chdirs: git.chdirs, projects: [] }
  const run = launched(command.argv)
  if (run === undefined || run === "not-run") return undefined
  if (run === "unparsed") return command.argv.some((word) => MENTIONS_FILTER_REPO.test(word)) ? "uncertain" : undefined
  // `git-filter-repo@2.47.0`, `git-filter-repo==2.47`, `git-filter-repo[extra]`: the executable is the name.
  const program = base(run.program.replace(/[@=<>~![].*$/, ""))
  if (!FILTER_REPO_NAME.test(program)) return undefined
  let { chdirs, projects } = run
  // uv rejects a repeated option; an option beats the matching environment variable.
  if (chdirs.length > 1 || projects.length > 1) return "uncertain"
  if (base(command.argv[0]).startsWith("uv")) {
    if (chdirs.length === 0) chdirs = assigned(command, "UV_WORKING_DIR")
    if (projects.length === 0) projects = assigned(command, "UV_PROJECT")
  }
  return { args: run.args, chdirs, projects }
}

/** Whether `arg` spells long option `name`, in full or as an argparse prefix (`--targ`), with or without `=value`. */
const spells = (arg: string, name: string): boolean => {
  const head = arg.split("=", 1)[0] as string
  return head.length > 2 && head.startsWith("--") && name.startsWith(head)
}

/** How many times the option is given under any spelling. */
const optionCount = (args: readonly string[], name: string): number => args.filter((arg) => spells(arg, name)).length

/** The value of `--name value` or `--name=value` under any spelling; the last one wins, as in filter-repo. */
function optionValue(args: readonly string[], name: string): string | undefined {
  let found: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!spells(arg, name)) continue
    found = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1]
  }
  return found
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const realOrSelf = (path: string): string => realOrUndefined(path) ?? path

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The folders whose clones are disposable: the OS temp directory, which holds OpenCode's. */
export function defaultTempRoots(): string[] {
  return [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].map(realOrSelf)
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)

const underTemp = (path: string, tempRoots: readonly string[]): boolean =>
  tempRoots.some((root) => within(path, realOrSelf(root)))

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
 * One directory change from the real directory `at`. The physical walk and the lexical path
 * (`..` removes the previous component) must reach the same real directory, and it must be a
 * directory. Otherwise `undefined`: the step is uncertain.
 */
function step(at: string, operand: string): string | undefined {
  const physical = enter(at, operand)
  if (physical === undefined || !isDirectory(physical)) return undefined
  return realOrUndefined(resolve(at, operand)) === physical ? physical : undefined
}

/**
 * A bounded read of a small regular file. The path is checked with `lstat` before it is opened, and
 * opened without blocking and without following a symlink, so a FIFO or device planted where
 * metadata belongs cannot hang the guard. `undefined` for anything that is not a small regular file.
 */
function readSmallFile(path: string): string | undefined {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) return undefined
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_METADATA) return undefined
    const buffer = Buffer.alloc(info.size)
    readSync(fd, buffer, 0, info.size, 0)
    return buffer.toString("utf8")
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Whether the gitfile at `gitFile` belongs to a linked worktree: `gitdir: <path>` names a directory
 * directly inside a `worktrees/` folder that holds a `commondir` file and a `gitdir` file pointing
 * back at this very `.git` file. Submodules and `--separate-git-dir` checkouts also have a gitfile,
 * and fail this.
 */
function linkedWorktree(gitFile: string): boolean {
  const text = readSmallFile(gitFile)
  const match = text === undefined ? null : /^gitdir:[ \t]*(.+?)[ \t]*\r?\n?$/.exec(text)
  if (match === null) return false
  const adminDir = realOrUndefined(isAbsolute(match[1] as string) ? (match[1] as string) : resolve(dirname(gitFile), match[1] as string))
  if (adminDir === undefined || !isDirectory(adminDir) || basename(dirname(adminDir)) !== "worktrees") return false
  if (readSmallFile(join(adminDir, "commondir")) === undefined) return false
  const back = readSmallFile(join(adminDir, "gitdir"))?.trim()
  if (back === undefined || back === "") return false
  return realOrUndefined(isAbsolute(back) ? back : resolve(adminDir, back)) === realOrUndefined(gitFile)
}

type Classified = { safe: true } | { safe: false; root: string; kind: "canonical" | "gitfile" }

/** Whether `dir` is a temp clone, a verified linked worktree, not in a repository (safe), or neither. */
function classify(dir: string, tempRoots: readonly string[]): Classified {
  if (underTemp(dir, tempRoots)) return { safe: true }
  let at = dir
  for (;;) {
    const git = join(at, ".git")
    try {
      const info = statSync(git)
      if (info.isDirectory()) return { safe: false, root: at, kind: "canonical" }
      return linkedWorktree(git) ? { safe: true } : { safe: false, root: at, kind: "gitfile" }
    } catch {
      // No .git here; look in the parent.
    }
    const parent = dirname(at)
    if (parent === at) return { safe: true }
    at = parent
  }
}

const isBranchRef = (ref: string | undefined): boolean => ref === "HEAD" || ref?.startsWith("refs/heads/") === true

/** A redirection's operator and descriptor, read from the source just before its target word. */
function redirectKind(command: Command, at: number): { operator: string; fd: string | undefined } | undefined {
  const word = command.redirects[at]
  if (word === undefined) return undefined
  const before = command.source.slice(Math.max(0, word.start - 12), word.start).trimEnd()
  const match = /(\d+|\{[A-Za-z_]\w*\})?(<<<|<<-|<<|<&|<>|<|>>|>&|>\||&>|>)$/.exec(before)
  return match === null ? undefined : { operator: match[2] as string, fd: match[1] }
}

/**
 * What a `git update-ref --stdin` transaction deletes. Only a sole literal here-document or
 * here-string is read; the shell uses the last stdin redirection, so any other arrangement (a pipe,
 * a file, `<&`, `-z`, two redirections, an expansion, a quoted field) counts as a possible branch
 * delete, as does an `update` with an empty new value.
 */
function stdinRewrite(command: Command, args: readonly string[]): string | undefined {
  const unreadable =
    "`git update-ref --stdin` (its transaction cannot be fully read, so a branch delete cannot be ruled out)"
  if (args.includes("-z")) return unreadable
  const stdin: { operator: string; at: number }[] = []
  let heredocs = 0
  const documentIndex = new Map<number, number>()
  for (let at = 0; at < command.redirects.length; at++) {
    const kind = redirectKind(command, at)
    if (kind === undefined) return unreadable
    if (kind.operator === "<<" || kind.operator === "<<-") documentIndex.set(at, heredocs++)
    const intoStdin = (kind.operator.startsWith("<") && (kind.fd === undefined || kind.fd === "0")) || (kind.operator === ">&" && kind.fd === "0")
    if (intoStdin) stdin.push({ operator: kind.operator, at })
  }
  if (stdin.length !== 1) return unreadable
  const only = stdin[0] as { operator: string; at: number }
  let source: string
  if (only.operator === "<<" || only.operator === "<<-") {
    const document = command.hereDocuments[documentIndex.get(only.at) as number]
    if (document === undefined || (!document.quoted && /[$`]/.test(document.body))) return unreadable
    // An unquoted body loses each backslash-newline before git reads it; a doubled backslash is an escaped one.
    source = document.quoted ? document.body : document.body.replace(/\\(\n|\\)/g, (_, next: string) => (next === "\n" ? "" : next))
  } else if (only.operator === "<<<") {
    const word = command.redirects[only.at]
    if (word === undefined || word.expands) return unreadable
    source = word.value
  } else return unreadable
  for (const line of source.split("\n")) {
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

/**
 * Whether a word that selects behaviour is spelled with an escape (`git $'--git-d\\151r=x'`,
 * `--tar\\147et`): the guard reads its text, not the shell's value, so it cannot tell what it does.
 */
const escapedSpelling = (words: readonly string[]): boolean => words.some((word) => word.startsWith("-") && word.includes("\\"))

/** The first construct in the whole shell command that could change where a rewrite runs. */
function directoryConstruct(commands: readonly Command[], runnerOk = false): string | undefined {
  const sources = new Set<string>()
  for (const command of commands) {
    const name = base(command.argv[0])
    // `xargs` only appends arguments; a caller that judges the command it runs may let it pass.
    if (CONSTRUCTS.has(name) && !(runnerOk && name === "xargs")) return `\`${name}\``
    if (SHELLS.has(name)) return `a nested shell (\`${name}\`)`
    const wrapper = command.wrappers.find((item) => CONSTRUCTS.has(item))
    if (wrapper !== undefined) return `\`${wrapper}\``
    if (command.directories.length > 0) return "a wrapper's directory option (`env -C`, `sudo -D`)"
    const git = gitInvocation(command.argv)
    if (git !== undefined && command.argv.slice(1, git.offset - 1).some((word) => word.startsWith("--exec-path")))
      return "`git --exec-path`"
    sources.add(command.source)
  }
  for (const source of sources) if (FUNCTION_DEFINITION.test(source)) return "a function definition"
  return undefined
}

/**
 * Subcommands that rewrite history or move and delete refs. Arguments appended after one can turn a harmless
 * call into a ref mutation (`xargs git branch` with `-D main` on stdin). Any other subcommand is fixed:
 * git resolves the repository before it dispatches, so appended words such as `--git-dir=…` or `-C` do not
 * redirect it (checked with `git status`, `log`, `show`, `diff`, `ls-files`, `add` and `config`).
 */
const REF_MUTATING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "filter-branch", "replace", "update-ref", "filter-repo",
  "branch", "tag", "push", "symbolic-ref", "reflog", "reset", "checkout", "switch", "rebase", "commit", "merge",
  "pull", "fetch", "cherry-pick", "revert", "gc", "prune", "repack", "stash", "notes", "worktree", "remote",
  "fast-import", "am", "bisect", "clone", "init",
])

const isGitWord = (argv: readonly string[]): boolean => ["git", "dgit"].includes(base(argv[0]))

/**
 * The command a runner (`xargs`, `parallel`, `find -exec`) starts, as its words, when stdin could make it a
 * rewrite, with whether stdin can also choose its target. Git with no visible subcommand, git-filter-repo and a
 * launcher of it take the subcommand, `-C`, `--git-dir` or `--target` from stdin, which the guard cannot read
 * (`hidden`). Git with a ref-mutating subcommand is judged by where it runs. A fixed other subcommand
 * (`xargs git show`) is left alone.
 */
type Runner = { started: string[]; hidden: boolean; wrapper?: string }

function runnerCommand(command: Command): Runner | undefined {
  const classify = (argv: readonly string[]): Runner | undefined => {
    if (isGitWord(argv)) {
      const visible = gitInvocation(argv)
      if (visible === undefined) return { started: [...argv], hidden: true }
      // `parallel git ::: args` and `find -exec git {} +` put the subcommand where the runner substitutes it.
      if (/^(?::+|-|.*[{}])/.test(visible.subcommand)) return { started: [...argv], hidden: true }
      return REF_MUTATING_SUBCOMMANDS.has(visible.subcommand) ? { started: [...argv], hidden: false } : undefined
    }
    if (FILTER_REPO_NAME.test(base(argv[0]))) return { started: [...argv], hidden: true }
    const run = launched(argv)
    return run === "unparsed" || (typeof run === "object" && MENTIONS_FILTER_REPO.test(run.program))
      ? { started: [...argv], hidden: true }
      : undefined
  }
  // The runner's program may sit behind wrappers (`env`, `nice`, `sudo`, …): classify what they run, and keep
  // the directory and environment uncertainty a wrapper brings.
  const completable = (raw: readonly string[]): Runner | undefined => {
    const { argv, directories } = commandWords(raw)
    const found = classify(argv)
    if (found === undefined) return undefined
    const wrapper = commandWrappers(raw).find((item) => CONSTRUCTS.has(item))
    if (directories.length > 0) return { ...found, wrapper: "a wrapper's directory option (`env -C`, `sudo -D`)" }
    return wrapper === undefined ? found : { ...found, wrapper: `\`${wrapper}\`` }
  }
  if (command.context === "xargs") {
    // The scanner already dropped the wrappers; keep what they imply.
    const found = classify(command.argv)
    if (found === undefined) return undefined
    const wrapper = command.wrappers.find((item) => CONSTRUCTS.has(item) && item !== "xargs")
    if (command.directories.length > 0) return { ...found, wrapper: "a wrapper's directory option (`env -C`, `sudo -D`)" }
    return wrapper === undefined ? found : { ...found, wrapper: `\`${wrapper}\`` }
  }
  const name = base(command.argv[0])
  const words = command.argv
  if (name === "find") {
    // The word after -exec/-execdir/-ok/-okdir is the program; its arguments run up to the action's terminator
    // (`;`, or `+` after `{}`). Words inside an action are its data, so skip past it before looking for the next one.
    let at = 1
    while (at < words.length) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[at] as string)) {
        at++
        continue
      }
      const end = words.findIndex(
        (word, index) => index > at && (word === ";" || word === "\\;" || (word === "+" && words[index - 1] === "{}")),
      )
      const found = completable(words.slice(at + 1, end === -1 ? undefined : end))
      if (found !== undefined) return found
      if (end === -1) break
      at = end + 1
    }
    return undefined
  }
  if (name === "parallel") {
    // No option table: its options take values the guard cannot place, and a value may be `:::` itself
    // (`--colsep :::`). Without options the first word is the program. With any option, every word after
    // `parallel` is scanned, across all separators: a git, filter-repo, launcher or wrapper word makes it unreadable.
    const rest = words.slice(1)
    if (!(rest[0] ?? "").startsWith("-")) {
      const end = rest.findIndex((word) => /^::::?$/.test(word))
      return completable(end === -1 ? rest : rest.slice(0, end))
    }
    const tool = rest.some(
      (word) =>
        isGitWord([word]) || FILTER_REPO_NAME.test(base(word)) || launched([word]) !== undefined || commandWrappers([word, "x"]).length > 0,
    )
    return tool ? { started: [...words], hidden: true } : undefined
  }
  return undefined
}

const GUIDANCE =
  "Clone the repository into a temp directory (`git clone <repo> \"$TMPDIR/<name>\"`) and run the command there with the tool's workdir set to the clone; a false refusal costs one retry."

const refused = (what: string, root: string): string =>
  `${PREFIX}: refused ${what}. ${root} is a canonical checkout (its .git is a directory), and this command rewrites or deletes history in place, which cannot be undone from the work tree. ${GUIDANCE}`

const unverified = (what: string, root: string): string =>
  `${PREFIX}: refused ${what}. ${root} has a .git file that is not a verified linked worktree (a submodule, a separate git directory, or unreadable metadata), and this command rewrites or deletes history in place. ${GUIDANCE}`

const uncertain = (what: string, why: string): string =>
  `${PREFIX}: refused ${what}. It rewrites or deletes history in place, and the guard cannot tell with certainty that it runs in a linked worktree or temp clone (${why}). ${GUIDANCE}`

const withConstruct = (what: string, construct: string): string =>
  `${PREFIX}: refused ${what}. The same shell command also contains ${construct}, which can change the directory the rewrite runs in, so the guard cannot tell where it runs. Set the shell tool's workdir to a temp clone or linked worktree, or run the rewrite on its own. ${GUIDANCE}`

/** The first option or variable in the shell command that selects a repository, by name only. */
function repositorySelection(commands: readonly Command[]): string | undefined {
  for (const source of new Set(commands.map((command) => command.source))) {
    const found = REPOSITORY_SELECTION.exec(source)
    if (found !== null) return found[0].trim().startsWith("-c") ? "`-c core.worktree` or `-c core.bare`" : `\`${found[0]}\``
  }
  return undefined
}

const withSelection = (what: string, selection: string): string =>
  `${PREFIX}: refused ${what}. ${selection} can point git at a repository other than the one the directory implies, so the guard cannot tell which repository the rewrite changes. Run the rewrite on its own in a temp clone, with the shell tool's workdir set there and without these options. ${GUIDANCE}`

/** Commands that only read or print their arguments: a rewrite word among them is data. */
const NON_EXECUTING: ReadonlySet<string> = new Set(["grep", "rg", "echo", "printf", "cat", "bd", "head", "tail", "wc", "ls", "pip", "pip3"])
/** Git subcommands that treat their arguments (`-m`, `--grep`, paths) as data. */
const GIT_DATA_SUBCOMMANDS: ReadonlySet<string> = new Set(["log", "commit", "show", "diff", "grep", "status", "add", "blame", "shortlog"])
/** Commands whose body the walker visits itself, so the commands inside are judged on their own. */
const DESCENDED: ReadonlySet<string> = new Set(["eval", "xargs"])
const REWRITE_FORM = /(?<![\w-])git[-_]filter[-_]repo(?![\w-])/
const REWRITE_WORD = /(?<![\w/.-])(?:filter-repo|filter-branch|update-ref|replace)(?![\w/-]|\.\w)/
const GIT_WORD = /(?<![\w/.-])d?git(?![\w-])/

/** Options that run a program or pager (`git grep -O`, `git diff --ext-diff`, `rg --pre`), whatever their value. */
const EXECUTABLE_OPTION =
  /^(?:-O|--(?:open-files-in-pager|ext-diff|textconv|exec|exec-path|pager|config-env|upload-pack|receive-pack|pre|pre-glob|hostname-bin)(?![\w-]))/
/** Options whose value is a pattern or message, never a program. */
const DATA_OPTION = /^(?:--grep|--message|--regexp|--pattern)$/
const mentioned = (word: string): boolean => REWRITE_FORM.test(word) || REWRITE_WORD.test(word)

/** Short options that take a value: `-e`/`-m` a pattern or message, `-f` a file, `-A`/`-B`/`-C` a count. */
const SHORT_VALUED = /[efmABC]/

/** The letters of a short-option cluster up to and including its first value-taking letter, and the index of that letter. */
function cluster(arg: string): { letters: string; at: number } {
  const letters = arg.slice(1)
  const at = letters.search(SHORT_VALUED)
  return { letters, at }
}

/**
 * Whether every rewrite word among `args` sits where the command treats it as data: a positional
 * pattern or path, or the value of `-e`, `-m`, `--grep`, `--message`. A program-running option is
 * looked for in every word, whatever option it might be the value of; only the data exemption
 * follows the options' values.
 */
function mentionsOnlyAsData(args: readonly string[]): boolean {
  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-") continue
    if (EXECUTABLE_OPTION.test(arg)) return false
    if (!arg.startsWith("--")) {
      const { letters, at } = cluster(arg)
      if (letters.slice(0, at < 0 ? undefined : at).includes("O")) return false
    }
  }
  let options = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (options && arg === "--") {
      options = false
      continue
    }
    if (!options || !arg.startsWith("-") || arg === "-") continue
    if (arg.startsWith("--")) {
      const head = arg.split("=", 1)[0] as string
      if (DATA_OPTION.test(head)) {
        if (!arg.includes("=")) i++
        continue
      }
    } else {
      const { letters, at } = cluster(arg)
      if (at >= 0) {
        const rest = letters.slice(at + 1)
        const value = rest === "" ? args[++i] : rest
        if (!"em".includes(letters[at] as string) && value !== undefined && mentioned(value)) return false
        continue
      }
    }
    if (mentioned(arg)) return false
  }
  return true
}

/**
 * Whether a launcher command is accounted for, given `filterRepo` already judged a directly
 * launched filter-repo: only an install or list (`not-run`, except `python -c`). Any other launcher
 * (launched git, a nested launcher, a program after a valued option the reader may misparse) that
 * mentions a rewrite is refused.
 */
function launcherJudged(argv: readonly string[]): boolean {
  return launched(argv) === "not-run" && !base(argv[0]).startsWith("python")
}

/**
 * The rewrite word a command names that the walker did not judge as a rewrite, or `undefined`.
 * A text-level fallback: a word counts as a mention when it sits in the command's own words with
 * `git` (or as `git-filter-repo`), unless the command only prints or searches its arguments, is a
 * shell the walker descends into, or is a git subcommand that treats them as data.
 */
function unaccountedMention(command: Command, git: GitInvocation | undefined): string | undefined {
  const text = command.argv.join(" ")
  const found = REWRITE_FORM.exec(text) ?? (GIT_WORD.test(text) ? REWRITE_WORD.exec(text) : null)
  if (found === null) return undefined
  const name = base(command.argv[0])
  if (SHELLS.has(name) || DESCENDED.has(name)) return undefined
  if (NON_EXECUTING.has(name) && mentionsOnlyAsData(command.argv.slice(1))) return undefined
  if (launcherJudged(command.argv)) return undefined
  if (git !== undefined) {
    if (["filter-branch", "replace", "update-ref"].includes(git.subcommand)) return undefined
    const plain = !git.overridden && !command.argv.slice(1, git.offset - 1).includes("-c")
    if (plain && GIT_DATA_SUBCOMMANDS.has(git.subcommand) && mentionsOnlyAsData(command.argv.slice(git.offset)))
      return undefined
  }
  return found[0]
}

/**
 * Why a command in `commands` is refused, or `undefined`. `cwd` is the tool call's workdir.
 * `tempRoots` replaces the default temp folders (tests).
 */
export function historyRewrite(
  commands: readonly Command[],
  cwd: string,
  tempRoots: readonly string[] = defaultTempRoots(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const judge = (
    what: string,
    moves: string[],
    git: GitInvocation | undefined,
    fileLast = false,
    runnerOk = false,
  ): string | undefined => {
    const selection = repositorySelection(commands)
    if (selection !== undefined) return withSelection(what, selection)
    const construct = directoryConstruct(commands, runnerOk)
    if (construct !== undefined) return withConstruct(what, construct)
    const inherited = INHERITED_SELECTION.find((name) => env[name] !== undefined)
    if (inherited !== undefined) return withSelection(what, `The session's environment sets \`${inherited}\`, which`)
    if (git?.overridden === true) return uncertain(what, "git was given a global option the guard does not read")
    const start = realOrUndefined(cwd)
    if (start === undefined) return uncertain(what, "the working directory cannot be resolved")
    if (moves.some(unreadable)) return uncertain(what, "a directory option is expanded by the shell or spelled with an escape")
    let dir = start
    for (const [at, operand] of moves.entries()) {
      // uv accepts a project file such as `pyproject.toml`: judge the directory that holds it.
      const held = fileLast && at === moves.length - 1 ? enter(dir, operand) : undefined
      const move = held !== undefined && !isDirectory(held) ? dirname(operand) : operand
      const next = step(dir, move)
      if (next === undefined) return uncertain(what, `\`${move}\` is not a directory that resolves the same way logically and physically`)
      dir = next
    }
    const where = classify(dir, tempRoots)
    if (where.safe) return undefined
    return where.kind === "canonical" ? refused(what, where.root) : unverified(what, where.root)
  }
  const unverifiable = (what: string): string =>
    `${PREFIX}: refused ${what}: write the command without $'…' or $"…" quoting; the guard can't verify it. ${GUIDANCE}`
  // A program word spelled with `$'…'` or `$"…"` could be bash, git or a launcher whose inner script the guard
  // never reads (`/bin/$'ba\163h' -c 'g""it …'`), so it is refused wherever it runs.
  for (const command of commands)
    if (quotedProgram(command)) return unverifiable(`\`${command.argv.slice(0, 4).join(" ")}\``)
  if (commands.some(ansiQuoted) && commands.some(gitOrLauncher)) {
    for (const command of commands) {
      if (!gitOrLauncher(command)) continue
      const git = gitInvocation(command.argv)
      const text = `\`${command.argv.slice(0, 4).join(" ")}\``
      // An escape may spell an option, a value or the program; only the git subcommand may carry one.
      if (command.argv.some((word, at) => word.includes("\\") && at !== (git?.offset ?? 0) - 1)) return unverifiable(text)
      // A subcommand spelled with an escape may be filter-repo, whose `--target` (or an abbreviation) moves it.
      if (git?.subcommand.includes("\\") === true && git.args.some((arg) => abbreviatesTarget(arg)))
        return unverifiable(text)
      if (judge(text, git?.chdirs ?? [], git) !== undefined) return unverifiable(text)
    }
  }
  // A runner can append arguments from stdin that the guard cannot see, so a git, filter-repo or launcher command
  // it starts is judged by where it would run: the workdir plus any visible `-C`, `--directory` or `--target`.
  for (const command of commands) {
    const found = runnerCommand(command)
    if (found === undefined) continue
    const { started, hidden } = found
    if (found.wrapper !== undefined)
      return withConstruct(`\`${started.slice(0, 4).join(" ")}\` run by \`${command.argv[0]}\``, found.wrapper)
    if (hidden)
      return `${PREFIX}: refused \`${started.slice(0, 4).join(" ")}\` run by \`${command.argv[0]}\`: its subcommand, \`-C\`, \`--git-dir\` or \`--target\` can come from stdin, which the guard cannot read, so it cannot tell where it runs. Write the arguments out in the command. ${GUIDANCE}`
    // `git -C x` has no subcommand yet: add a placeholder so its options still parse.
    const startedGit = gitInvocation(started) ?? (isGitWord(started) ? gitInvocation([...started, "x"]) : undefined)
    const target = FILTER_REPO_NAME.test(base(started[0])) || startedGit?.subcommand === "filter-repo"
      ? optionValue(startedGit?.args ?? started.slice(1), "--target")
      : undefined
    const uv = base(started[0]).startsWith("uv") ? uvDirectories(started, 1, started.length) : { chdirs: [], projects: [] }
    const moves = [...(startedGit?.chdirs ?? []), ...uv.chdirs, ...(target === undefined ? [] : [target])]
    const text = `\`${started.slice(0, 4).join(" ")}\` run by \`${command.argv[0]}\``
    for (const chain of [moves, ...uv.projects.map((project) => [...uv.chdirs, project])]) {
      const reason = judge(text, chain, startedGit, chain !== moves, true)
      if (reason !== undefined) return reason
    }
  }
  for (const [position, command] of commands.entries()) {
    const git = gitInvocation(command.argv)
    const text = `\`${command.argv.slice(0, 4).join(" ")}\``
    const rewrite = filterRepo(command)
    if (rewrite === "uncertain") return uncertain(text, "the launcher's command line could not be read")
    if (rewrite !== undefined) {
      if (base(command.argv[0]).startsWith("uv")) {
        // A wrapper (`sudo`, `env -i`, `nice`, …) may drop an inline variable, and an earlier segment may set one.
        if (command.wrappers.length > 0 && UV_DIRECTORY_ENV.test(command.source))
          return uncertain(text, "a wrapper may drop or change uv's UV_WORKING_DIR or UV_PROJECT")
        if (commands.slice(0, position).some(setsUvDirectory))
          return uncertain(text, "an earlier command may set uv's UV_WORKING_DIR or UV_PROJECT")
      }
      if (rewrite.args.some((arg) => arg === "-f" || spells(arg, "--force")))
        return `${PREFIX}: refused ${text} with --force. filter-repo --force overwrites the repository's refs and history in the directory it runs in, wherever that is. Run it without --force in a fresh temp clone with the tool's workdir set there; a fresh clone needs no --force.`
      if (escapedSpelling(command.argv.slice(1)))
        return uncertain(text, "an option is spelled with a shell escape, so its name cannot be read")
      if (command.source.includes('$"')) return uncertain(text, LOCALE_REASON)
      for (const option of ["--target", "--source"])
        if (optionCount(rewrite.args, option) > 1)
          return uncertain(text, `\`${option}\` is repeated (possibly abbreviated) and filter-repo uses the last one`)
      const target = optionValue(rewrite.args, "--target")
      const moves = [...rewrite.chdirs, ...(target === undefined ? [] : [target])]
      const reason = judge(text, moves, git)
      if (reason !== undefined) return reason
      // `--project` does not move the process; it is resolved from uv's effective directory.
      for (const project of rewrite.projects) {
        const inProject = judge(text, [...rewrite.chdirs, project], git, true)
        if (inProject !== undefined) return inProject
      }
      continue
    }
    const mention = unaccountedMention(command, git)
    if (mention !== undefined)
      return uncertain(text, `the command text mentions \`${mention}\` where the guard could not parse a rewrite`)
    if (git === undefined) continue
    let what: string | undefined
    if (git.subcommand === "filter-branch") what = `\`git ${git.subcommand}\``
    else if (git.subcommand === "replace") {
      const reads = git.args.some((arg) => arg === "-l" || arg === "--list" || arg.startsWith("--format"))
      if (!reads) what = `\`git ${git.subcommand}\``
    } else if (git.subcommand === "update-ref") what = updateRefRewrite(command, git)
    if (what === undefined) continue
    if (escapedSpelling(command.argv.slice(1, git.offset - 1)))
      return uncertain(what, "a git option is spelled with a shell escape, so its name cannot be read")
    if (command.source.includes('$"')) return uncertain(what, LOCALE_REASON)
    const reason = judge(what, git.chdirs, git)
    if (reason !== undefined) return reason
  }
  return undefined
}
