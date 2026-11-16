/**
 * Allowlist guard for git commands, failing closed.
 *
 * Permission rules cannot see past git's global options (`git -C dir push`, `git -Cx push`),
 * wrappers (`\git`, `/usr/bin/git`, `command git`, `env`), shell payloads (`bash -lc '…'`,
 * heredocs) or aliases. This guard instead accepts a git invocation only when its subcommand is
 * on a per-agent allowlist, so a spelling it does not know is refused rather than allowed.
 *
 * Commands that never mention git are left alone. Anything that mentions git and cannot be read
 * statically (a shell reading a script from stdin, a variable in command position, a parse
 * failure) is refused.
 *
 * Limits of static parsing: a program that runs git on its own (a script file, `make`, an npm
 * script, a git hook, an interpreter reading code from a file) is not seen. Inline interpreter
 * code that mentions git is refused, and `git bisect run` scripts must sit in the scratch
 * worktree, but nothing else can be proven here.
 */

import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { commandWords } from "@srobroek/opencode-lib/command-words"
import { type CommandPosition, type ParsedCommand, parse } from "@srobroek/opencode-lib/shell-command"
import { isShellTool, shellCall } from "@srobroek/opencode-lib/tool-targets"
import { checkDebugWrite, isScratchPath } from "./path-guard.ts"

/** What the guard needs to know about where a command runs. */
export type GitContext = {
  /** The directory the session started in, the user's checkout. */
  startDir?: string
  /** The shell call's `workdir`, relative to `startDir`. */
  workdir?: string
  /** The user's home directory. Defaults to `os.homedir()`. */
  home?: string
}

type Policy = { subcommands: ReadonlySet<string> }

const COMMON = [
  "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "blame", "grep",
  "worktree", "branch", "switch", "checkout", "commit", "add", "restore", "stash", "reset", "cherry-pick", "revert",
  "apply", "am", "format-patch", "describe", "merge-base", "for-each-ref", "config", "fetch", "remote", "tag",
]

const POLICIES: Readonly<Record<string, Policy>> = {
  debug: { subcommands: new Set([...COMMON, "bisect"]) },
  refactor: { subcommands: new Set(COMMON) },
}

/** The agents this guard covers. */
export const GUARDED_AGENTS: readonly string[] = Object.keys(POLICIES)

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
/** Runners whose later words are a command. */
const RUNNERS = new Set(["xargs", "watch", "setsid", "parallel"])
const XARGS_VALUED = new Set(["-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "-J"])

const BOOLEAN_GLOBALS = new Set([
  "--no-pager", "--paginate", "-p", "-P", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice", "--version",
  "--help", "--html-path", "--man-path", "--info-path",
])
const VALUED_GLOBALS = new Set(["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"])
/** `-c` keys that cannot run a command or rewrite an alias. */
const SAFE_CONFIG =
  /^(core\.(quotepath|autocrlf|whitespace|abbrev|precomposeunicode)|color\.[a-z.]+|diff\.(algorithm|renames|context|noprefix|mnemonicprefix)|log\.[a-z]+|user\.(name|email)|commit\.gpgsign|gc\.auto|advice\.[a-z]+|safe\.directory|protocol\.version|init\.defaultbranch)$/i
const DANGEROUS_ENV =
  /^(GIT_(CONFIG[A-Z_0-9]*|SSH|SSH_COMMAND|ASKPASS|EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|EXEC_PATH|PROXY_COMMAND|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|TEMPLATE_DIR)|SSH_ASKPASS|EDITOR|VISUAL|PAGER)=/
/** Options that run a command chosen by the caller. Output paths are checked separately. */
const RISKY_OPTION = /^--(upload-pack|receive-pack|exec|open-files-in-pager|ext-diff|textconv)(=|$)/
const MENTIONS_GIT = /git/i
/** A command that is worth parsing: it mentions git or has a word that could expand into it. */
const WORTH_PARSING = /git|[{*?[$`]/i
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "(", "coproc"])
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|perl|ruby|php|lua|awk|gawk|mawk|osascript|tclsh|Rscript)$/
const INLINE_CODE_RUNNERS = /^(bun|deno)$/
const unbackslash = (word: string) => word.replace(/\\(.)/gs, "$1")
const escapeRegex = (text: string) => text.replace(/[.+^${}()|[\]\\*?]/g, "\\$&")

/** A regular expression for the strings a glob or brace word can expand to. */
function wordPattern(word: string): RegExp {
  let out = ""
  for (let i = 0; i < word.length; i++) {
    const c = word[i] as string
    if (c === "*") out += ".*"
    else if (c === "?") out += "."
    else if (c === "[" && word.indexOf("]", i + 1) > 0) {
      const end = word.indexOf("]", i + 1)
      out += word.slice(i, end + 1)
      i = end
    } else if (c === "{" && word.indexOf("}", i + 1) > 0) {
      const end = word.indexOf("}", i + 1)
      out += `(?:${word.slice(i + 1, end).split(",").map(escapeRegex).join("|")})`
      i = end
    } else out += escapeRegex(c)
  }
  return new RegExp(`^${out}$`)
}

/** Whether a command word with a glob or brace could name the git executable. */
function couldBeGit(word: string): boolean {
  const pattern = wordPattern(word)
  return ["git", "./git", "/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git"].some((name) => pattern.test(name))
}

const basename = (word: string) => word.replace(/^\\+/, "").split("/").pop() ?? word
/** Whether `arg` is `--full` or an abbreviation of it git would accept (three characters or more). */
const longOption = (arg: string, full: string) => {
  const name = arg.split("=")[0] ?? arg
  return name.startsWith("--") && name.length >= 3 && full.startsWith(name)
}
/** Whether a short-option cluster such as `-dr` contains one of `letters`. */
const cluster = (arg: string, letters: string) => /^-[^-]/.test(arg) && [...arg.slice(1)].some((c) => letters.includes(c))

/**
 * `path` placed after `base`, with `~/` expanded; undefined when a relative path has no known base.
 * Nothing is normalised: `link/..` must reach the path guards as written, because only they know
 * whether `link` is a symlink.
 */
function joinPath(base: string | undefined, path: string, home?: string): string | undefined {
  if (path === "~" || path.startsWith("~/")) return `${(home ?? homedir()).replace(/\/$/, "")}${path.slice(1)}`
  if (isAbsolute(path)) return path
  return base === undefined ? undefined : `${base.replace(/\/$/, "")}/${path}`
}

/** Why `args` (the words after `git`) is refused for `policy`, or undefined. */
function checkGit(args: readonly string[], ctx: Ctx, cwd: string | undefined): string | undefined {
  const { agent, policy } = ctx
  const refuse = (what: string) => `${what} is not allowed for the ${agent} agent`
  let tree = cwd
  let gitDir = false
  let i = 0
  for (; i < args.length; i++) {
    const word = args[i] as string
    if (!word.startsWith("-")) break
    if (word === "-C" || word === "-c") {
      const value = args[++i]
      if (word === "-c" && (value === undefined || !SAFE_CONFIG.test(value.split("=")[0] ?? ""))) return refuse(`git -c ${value ?? ""}`)
      if (value === undefined) return refuse("git -C without a path")
      if (word === "-C") tree = joinPath(tree, value, ctx.env.home)
    } else if (word.startsWith("-C")) {
      tree = joinPath(tree, word.slice(2), ctx.env.home)
    } else if (word.startsWith("-c")) {
      if (!SAFE_CONFIG.test(word.slice(2).split("=")[0] ?? "")) return refuse(`git ${word}`)
    } else if (word.startsWith("--exec-path")) {
      // --exec-path[=<path>] takes no separate value, but it redirects git's helpers
      return refuse("git --exec-path")
    } else if (BOOLEAN_GLOBALS.has(word)) {
      // no value
    } else if (word === "--config-env" || word.startsWith("--config-env=")) {
      const value = word === "--config-env" ? args[++i] : word.slice("--config-env=".length)
      if (value === undefined || !SAFE_CONFIG.test(value.split("=")[0] ?? "")) return refuse(`git --config-env ${value ?? ""}`)
    } else if (VALUED_GLOBALS.has(word) || (VALUED_GLOBALS.has(word.split("=")[0] ?? "") && word.includes("="))) {
      const name = word.split("=")[0] as string
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : args[++i]
      if (value === undefined) return refuse(`git ${word} without a value`)
      if (name === "--work-tree") tree = joinPath(tree, value, ctx.env.home)
      if (name === "--git-dir") gitDir = true
    } else return refuse(`git option ${word}`)
  }
  const sub = args[i]
  if (sub === undefined) return undefined
  const rest = args.slice(i + 1)
  if (!policy.subcommands.has(sub)) return refuse(`git ${sub}`)
  const risky = rest.find((arg) => RISKY_OPTION.test(arg) || (sub === "grep" && /^-O/.test(arg)))
  if (risky !== undefined) return refuse(`git ${sub} ${risky}`)
  if (agent === "debug" && changesTree(sub, rest)) {
    if (gitDir) return refuse(`git ${sub} with --git-dir`)
    if (tree === undefined || !scratch(tree, ctx)) return refuse(`git ${sub} outside a debug-* scratch worktree (it would change the user's checkout or shared refs)`)
  }
  const outputs = outputDestinations(sub, rest)
  if (outputs === undefined) return refuse(`git ${sub} with an output option that has no path`)
  for (const destination of outputs) {
    const reason = checkDestination(destination, tree, ctx)
    if (reason !== undefined) return refuse(`git ${sub} writing to ${destination} (${reason})`)
  }
  switch (sub) {
    case "reset":
      if (rest.some((arg) => longOption(arg, "--hard"))) return refuse("git reset --hard")
      break
    case "branch":
      if (
        rest.some(
          (arg) =>
            cluster(arg, "dDmMcCfu") ||
            ["--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description"].some((full) =>
              longOption(arg, full),
            ),
        )
      )
        return refuse("git branch with a delete, move, copy or force option")
      break
    case "config": {
      const read = rest.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(arg))
      const write = rest.some((arg) =>
        ["--add", "--unset", "--unset-all", "--replace-all", "--edit", "-e", "--rename-section", "--remove-section", "--global", "--system", "--file", "-f"].includes(arg),
      )
      if (!read || write) return refuse("git config writes")
      break
    }
    case "remote": {
      const [first, ...others] = rest
      const ok = first === undefined || first === "-v" || first === "--verbose" || (first === "get-url" && others.every((arg) => !arg.startsWith("-") || arg === "--all"))
      if (!ok) return refuse("git remote changes")
      break
    }
    case "tag": {
      const list = rest.some((arg) => arg === "-l" || arg === "--list")
      if (rest.some((arg) => cluster(arg, "dasfmuF") || ["--delete", "--force", "--annotate", "--sign", "--message", "--local-user"].some((f) => longOption(arg, f))))
        return refuse("git tag with a create or delete option")
      if (rest.some((arg) => !arg.startsWith("-")) && !list) return refuse("git tag creating a tag")
      break
    }
    case "bisect":
      if (rest[0] === "run") return checkRunner(rest.slice(1), ctx, tree)
      break
    case "stash":
      // Stash refs are shared by every worktree, so drop, clear, pop and apply could delete or apply someone else's work.
      if (rest[0] !== undefined && !rest[0].startsWith("-") && !["list", "show", "push", "save"].includes(rest[0]))
        return refuse(`git stash ${rest[0]}`)
      break
    case "worktree": {
      const action = rest[0] ?? ""
      if (!["add", "list", "remove", "lock", "unlock", "move", "repair"].includes(action)) return refuse(`git worktree ${action}`)
      if (action === "add" || action === "remove") {
        const target = worktreeTarget(action, rest.slice(1))
        const resolved = target === undefined ? undefined : joinPath(tree, target, ctx.env.home)
        if (resolved === undefined || !scratch(resolved, ctx)) return refuse(`git worktree ${action} outside a debug-* scratch worktree`)
      }
      break
    }
  }
  return undefined
}

/**
 * Check the command `git bisect run` repeats. A bare command (`bun test`) goes through the same
 * guard as any other. A script cannot be read, so it is allowed only inside a debug scratch worktree.
 */
function checkRunner(runner: readonly string[], ctx: Ctx, tree: string | undefined): string | undefined {
  const refuse = (what: string) => `git bisect run ${what} is not allowed for the ${ctx.agent} agent`
  const { argv } = realCommand(runner)
  const first = argv[0]
  if (first === undefined) return refuse("without a command")
  if (/[$`*?[{~]/.test(first)) return refuse(`${first}: a variable or glob in the command cannot be checked`)
  const exe = basename(first)
  const shell = SHELLS.has(exe)
  const inline = shell && argv.slice(1).some((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
  // A shell given a script file has nothing to read here, so that script is checked as a path below.
  if (!shell || inline) {
    const nested = checkWords(runner, deeper(ctx))
    if (nested !== undefined) return nested
  }
  let script: string | undefined
  if (first.includes("/")) script = first
  else if ((shell || INTERPRETERS.test(exe)) && !inline) script = argv.slice(1).find((arg) => !arg.startsWith("-"))
  if (script === undefined) return undefined
  const resolved = joinPath(tree, script, ctx.env.home)
  return resolved !== undefined && scratch(resolved, ctx) ? undefined : refuse(`${script}: a script outside a debug-* scratch worktree cannot be checked`)
}

/** Whether a git subcommand changes its work tree, index or refs. `worktree add|remove` have their own rule. */
function changesTree(sub: string, rest: readonly string[]): boolean {
  switch (sub) {
    case "commit":
    case "add":
    case "restore":
    case "checkout":
    case "switch":
    case "reset":
    case "cherry-pick":
    case "revert":
    case "apply":
    case "am":
      return true
    case "stash":
      return !["list", "show"].includes(rest[0] ?? "")
    case "branch":
      return (
        rest.some((arg) => !arg.startsWith("-")) &&
        !rest.some((arg) => ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"].includes(arg))
      )
    case "bisect":
      return !["log", "visualize", "view", "terms"].includes(rest[0] ?? "")
    case "worktree":
      return ["lock", "unlock", "move", "repair"].includes(rest[0] ?? "")
    default:
      return false
  }
}

/** The path argument of `git worktree add|remove`. */
function worktreeTarget(action: string, args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === "--") return args[i + 1]
    if (!arg.startsWith("-")) return arg
    if (action === "add" && ["-b", "-B", "--reason"].includes(arg)) i++
  }
  return undefined
}

/** Whether `path` is a debug scratch worktree (or inside one) for this session. */
function scratch(path: string, ctx: Ctx): boolean {
  return ctx.env.startDir !== undefined && isScratchPath(path, { home: ctx.env.home, startDir: ctx.env.startDir })
}

/**
 * The paths a git subcommand's output options write to, or undefined when an option has no value.
 * Covers `--output[=]` and `--output-directory[=]` (and the abbreviations git accepts), and
 * `-o <dir>` for `format-patch`.
 */
function outputDestinations(sub: string, rest: readonly string[]): string[] | undefined {
  const found: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (arg === "--") break
    const name = arg.split("=")[0] as string
    const long = name.startsWith("--") && name.length >= 3 && ("--output".startsWith(name) || "--output-directory".startsWith(name))
    const short = sub === "format-patch" && arg.startsWith("-o")
    if (!long && !short) continue
    const value = long ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rest[++i]) : arg.length > 2 ? arg.slice(2) : rest[++i]
    if (value === undefined || value === "") return undefined
    found.push(value)
  }
  return found
}

/** Why a git output path is refused, or undefined when it lands in a scratch worktree or the debug ledger directory. */
function checkDestination(destination: string, tree: string | undefined, ctx: Ctx): string | undefined {
  const { startDir, home } = ctx.env
  const resolved = joinPath(tree, destination, ctx.env.home)
  if (startDir === undefined || resolved === undefined) return "the destination or the start directory is unknown"
  if (scratch(resolved, ctx) || checkDebugWrite(resolved, { home, startDir }) === undefined) return undefined
  return "outside a debug-* scratch worktree and ~/.opencode/debug"
}

/** Words after the xargs/watch/parallel options, as the command they run. */
function runnerCommand(exe: string, args: readonly string[]): string[] {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith("-")) i += exe === "xargs" && XARGS_VALUED.has(args[i] as string) ? 2 : 1
  return args.slice(i)
}

/** The command a simple command runs, with the directories its wrappers change into. */
function realCommand(input: readonly string[]): { argv: string[]; directories: string[] } {
  let current = input.map(unbackslash)
  const directories: string[] = []
  for (let round = 0; round < 6; round++) {
    let start = 0
    while (start < current.length && KEYWORDS.has(current[start] as string)) start++
    const words = commandWords(current.slice(start))
    directories.push(...words.directories)
    if (start === 0 && words.argv.length === current.length) return { argv: words.argv, directories }
    current = words.argv
  }
  return { argv: current, directories }
}

type Ctx = {
  agent: string
  policy: Policy
  mentions: boolean
  depth: number
  env: GitContext
  /** The current directory as `cd` changes it; undefined once it cannot be known. Shared by the commands of one line. */
  state: { cwd: string | undefined }
  /** Whether `cd` can be followed: the line is only `&&`-joined commands. */
  trusted: boolean
}
const deeper = (ctx: Ctx): Ctx => ({ ...ctx, depth: ctx.depth + 1 })

function checkWords(input: readonly string[], ctx: Ctx): string | undefined {
  const { agent, mentions } = ctx
  if (ctx.depth > 6) return "the command nests too deeply to check its git use"
  const dangerous = input.find((word) => DANGEROUS_ENV.test(word))
  if (dangerous !== undefined) return `${dangerous.split("=")[0]} can make git run a command or read other config, which is not allowed for the ${agent} agent`
  const { argv, directories } = realCommand(input)
  const first = argv[0]
  if (first === undefined) return undefined
  const exe = basename(first)
  const args = argv.slice(1)
  if (/[$`]/.test(first) && mentions) return "a variable or substitution in command position cannot be checked"
  if (/[*?[{]/.test(first) && (mentions || couldBeGit(first))) return "a glob or brace in command position could name git, so it cannot be checked"
  if (exe === "git") {
    let cwd = ctx.state.cwd
    for (const directory of directories) cwd = joinPath(cwd, directory, ctx.env.home)
    return checkGit(args, ctx, cwd)
  }
  if (
    (INTERPRETERS.test(exe) || (INLINE_CODE_RUNNERS.test(exe) && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg)))) &&
    args.some((arg) => MENTIONS_GIT.test(arg))
  )
    return "an interpreter running code that mentions git cannot be checked"
  if (SHELLS.has(exe)) {
    const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
    const payload = flag >= 0 ? args[flag + 1] : undefined
    if (payload === undefined) return "a shell reading its script from stdin or a file cannot be checked"
    return checkCommand(payload, deeper(ctx))
  }
  if (exe === "eval") return checkCommand(args.join(" "), deeper(ctx))
  if (RUNNERS.has(exe)) return checkWords(runnerCommand(exe, args), deeper(ctx))
  if (exe === "find") {
    for (let i = 0; i < args.length; i++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i] as string)) continue
      const end = args.findIndex((arg, j) => j > i && (arg === ";" || arg === "+" || arg === "\\;"))
      const reason = checkWords(args.slice(i + 1, end < 0 ? undefined : end), deeper(ctx))
      if (reason !== undefined) return reason
    }
  }
  return undefined
}

const CD_UNSAFE = /[$`*?[{~]/

/** Follow `cd` (and drop track on `pushd`/`popd`) so later git commands know their directory. */
function followDirectory(position: CommandPosition, ctx: Ctx): boolean {
  const { argv } = realCommand(position.argv)
  const exe = basename(argv[0] ?? "")
  if (exe === "pushd" || exe === "popd") ctx.state.cwd = undefined
  else if (exe === "cd") {
    const target = argv[1]
    ctx.state.cwd =
      ctx.trusted && target !== undefined && !target.startsWith("-") && !CD_UNSAFE.test(target) && argv.length === 2
        ? joinPath(ctx.state.cwd, target, ctx.env.home)
        : undefined
  } else return false
  return true
}

function checkParsed(parsed: ParsedCommand, ctx: Ctx): string | undefined {
  for (const position of parsed.commands as CommandPosition[]) {
    if (followDirectory(position, ctx)) continue
    const reason = checkWords(position.argv, ctx)
    if (reason !== undefined) return reason
  }
  for (const child of parsed.nested) {
    const reason = checkParsed(child, { ...deeper(ctx), state: { cwd: ctx.state.cwd }, trusted: onlyAndChains(child.command) })
    if (reason !== undefined) return reason
  }
  return undefined
}

/** Only `&&` joins the commands: no subshell, group, pipe, `;`, `||`, background or substitution. */
const onlyAndChains = (command: string) => !/[;|&(){}`\n]|\$\(/.test(command.replaceAll("&&", " "))

function checkCommand(command: string, ctx: Ctx): string | undefined {
  const text = unbackslash(command.replace(/['"]/g, ""))
  if (!WORTH_PARSING.test(text)) return undefined
  const parsed = parse(command)
  if (parsed.unknown) return MENTIONS_GIT.test(text) || ctx.mentions ? "the command could not be parsed, so its git use cannot be checked" : undefined
  return checkParsed(parsed, { ...ctx, mentions: ctx.mentions || MENTIONS_GIT.test(text), state: { cwd: ctx.state.cwd }, trusted: onlyAndChains(command) })
}

/** The directory a shell call starts in: its `workdir` against the session's start directory. */
function startingDirectory(env: GitContext): string | undefined {
  if (env.workdir !== undefined && isAbsolute(env.workdir)) return env.workdir
  if (env.startDir === undefined) return undefined
  return env.workdir === undefined ? env.startDir : joinPath(env.startDir, env.workdir, env.home)
}

/** Why `command` is refused for `agent`, or undefined when it may run. */
export function forbiddenGit(command: string, agent: string, env: GitContext = {}): string | undefined {
  const policy = POLICIES[agent]
  if (policy === undefined) return undefined
  return checkCommand(command, {
    agent,
    policy,
    mentions: false,
    depth: 0,
    env,
    state: { cwd: startingDirectory(env) },
    trusted: onlyAndChains(command),
  })
}

/**
 * `forbiddenGit` for a shell tool call, read the way the host reads it: an alias such as `bash`
 * with an argv-array command is normalised first, so the guard sees the same string that runs.
 * A shell call whose input has no recognisable command is refused for guarded agents, because
 * another hook may rewrite it into one.
 */
export function guardShellCall(tool: string, input: unknown, agent: string, env: GitContext = {}): string | undefined {
  if (POLICIES[agent] === undefined || !isShellTool(tool)) return undefined
  const call = shellCall(tool, input)
  if (call === undefined || call.command.trim() === "") return "the shell input has no recognisable command, so its git use cannot be checked"
  return forbiddenGit(call.command, agent, { ...env, workdir: call.workdir ?? env.workdir })
}
