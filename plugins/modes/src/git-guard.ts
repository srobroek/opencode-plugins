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
import { checkDebugWrite, isScratchPath, isScratchRoot } from "./path-guard.ts"

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
  "apply", "am", "format-patch", "describe", "merge-base", "for-each-ref", "config", "remote", "tag",
]

const POLICIES: Readonly<Record<string, Policy>> = {
  debug: { subcommands: new Set([...COMMON, "bisect"]) },
  // fetch writes refs and objects into the repository every worktree shares, so debug does not get it.
  refactor: { subcommands: new Set([...COMMON, "fetch"]) },
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
type InterpreterSpec = {
  name: RegExp
  /** Options that carry inline code. */
  inline: readonly string[]
  /** Options that take the next word as a value, so that word is not the script. */
  valued: readonly string[]
  /** Options after which the interpreter stops reading its own options (a module or a file to run). */
  stop: readonly string[]
  /** Whether the first inline program ends the interpreter's own options (the rest are the program's arguments). */
  once: boolean
}

/** How each interpreter reads its command line. Only options before the script, module or subcommand are inspected. */
const INTERPRETERS_SPECS: readonly InterpreterSpec[] = [
  { name: /^python[0-9.]*$/, inline: ["-c"], valued: ["-W", "-X", "-Q"], stop: ["-m"], once: true },
  {
    name: /^(node|nodejs)$/,
    inline: ["-e", "-p", "--eval", "--print"],
    valued: ["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--input-type", "--env-file"],
    stop: [],
    once: true,
  },
  { name: /^bun$/, inline: ["-e", "-p", "--eval", "--print"], valued: ["--cwd", "-c", "--config", "--env-file", "--preload", "-r", "--port"], stop: [], once: true },
  { name: /^perl$/, inline: ["-e", "-E"], valued: ["-I"], stop: [], once: false },
  { name: /^ruby$/, inline: ["-e"], valued: ["-I", "-r", "-C", "-E"], stop: [], once: false },
  { name: /^php$/, inline: ["-r"], valued: ["-c", "-d", "-z"], stop: ["-f"], once: true },
  { name: /^lua$/, inline: ["-e"], valued: ["-l"], stop: [], once: false },
  { name: /^(Rscript|osascript)$/, inline: ["-e"], valued: ["-l"], stop: [], once: false },
]
const AWKS = /^(awk|gawk|mawk)$/
/** An operand that the shell or git would expand into something the guard cannot see. A leading `~/` is expanded by the guard. */
const unsafeOperand = (path: string) => /[$`*?[{]/.test(path) || /^~[^/]/.test(path)
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

/** The inline program text an interpreter is given on its command line, if any. */
function inlineCode(exe: string, args: readonly string[]): string[] {
  if (AWKS.test(exe)) {
    if (args.includes("-f")) return []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string
      if (arg === "--") return args[i + 1] === undefined ? [] : [args[i + 1] as string]
      if (arg === "-F" || arg === "-v") i++
      else if (!arg.startsWith("-")) return [arg]
    }
    return []
  }
  if (exe === "deno") {
    const subcommand = args.findIndex((arg) => !arg.startsWith("-"))
    return subcommand >= 0 && args[subcommand] === "eval" ? args.slice(subcommand + 1).filter((arg) => !arg.startsWith("-")) : []
  }
  const spec = INTERPRETERS_SPECS.find((candidate) => candidate.name.test(exe))
  if (spec === undefined) return []
  const code: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === "--" || spec.stop.includes(arg)) break
    const option = spec.inline.find((name) => arg === name || arg.startsWith(`${name}=`) || (!name.startsWith("--") && arg.startsWith(name) && arg.length > name.length))
    if (option !== undefined) {
      if (arg === option) code.push(args[++i] ?? "")
      else code.push(arg.slice(arg.startsWith(`${option}=`) ? option.length + 1 : option.length))
      if (spec.once) break
    } else if (spec.valued.includes(arg)) i++
    else if (!arg.startsWith("-")) break
  }
  return code
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
function checkGit(args: readonly string[], ctx: Ctx, cwd: string | undefined, wrapped: boolean): string | undefined {
  const { agent, policy } = ctx
  const refuse = (what: string) => `${what} is not allowed for the ${agent} agent`
  let tree = cwd
  let redirected = false
  let i = 0
  for (; i < args.length; i++) {
    const word = args[i] as string
    if (!word.startsWith("-")) break
    if (word === "-C" || word === "-c") {
      const value = args[++i]
      if (word === "-c" && (value === undefined || !SAFE_CONFIG.test(value.split("=")[0] ?? ""))) return refuse(`git -c ${value ?? ""}`)
      if (value === undefined) return refuse("git -C without a path")
      if (word === "-C") redirected = true
      if (word === "-C") tree = unsafeOperand(value) ? undefined : joinPath(tree, value, ctx.env.home)
    } else if (word.startsWith("-C")) {
      redirected = true
      tree = unsafeOperand(word.slice(2)) ? undefined : joinPath(tree, word.slice(2), ctx.env.home)
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
      if (name === "--work-tree") tree = unsafeOperand(value) ? undefined : joinPath(tree, value, ctx.env.home)
      if (name === "--git-dir" || name === "--work-tree" || name === "--namespace") redirected = true
    } else return refuse(`git option ${word}`)
  }
  const sub = args[i]
  if (sub === undefined) return undefined
  const rest = args.slice(i + 1)
  if (!policy.subcommands.has(sub)) return refuse(`git ${sub}`)
  const risky = rest.find((arg) => RISKY_OPTION.test(arg) || (sub === "grep" && /^-O/.test(arg)))
  if (risky !== undefined) return refuse(`git ${sub} ${risky}`)
  if (agent === "debug") {
    const form = branchForm(sub, rest)
    if (form.why !== undefined) return refuse(form.why)
    if (sub === "worktree" && rest[0] === "add") {
      if (!worktreeAddForm(rest.slice(1))) return refuse("git worktree add is not an allowed form; use --detach <path> [<start>] or -b debug/<slug> <path> [<start>]")
      ctx.report.mutating++
      ctx.report.branch++
    }
    if (form.change) ctx.report.branch++
  }
  if (agent === "debug" && changesTree(sub, rest)) {
    // Only the shell's workdir is trusted: -C, --work-tree, cd, wrappers and nested shells all change
    // the tree in ways that are hard to follow, so they are refused for commands that write.
    const base = startingDirectory(ctx.env)
    const why = redirected
      ? "uses -C, --work-tree, --git-dir or --namespace"
      : wrapped
        ? "runs through a wrapper that changes directory"
        : ctx.state.moved
          ? "runs after cd, pushd or popd"
          : ctx.depth > 0
            ? "runs inside a nested shell, substitution or runner"
            : base === undefined || !scratch(base, ctx)
              ? "does not have a debug-* scratch worktree as its workdir"
              : undefined
    if (why !== undefined)
      return refuse(`git ${sub} ${why}; run it directly with the shell workdir set to your debug-* scratch worktree`)
    ctx.report.mutating++
  }
  const outputs = outputDestinations(sub, rest)
  // format-patch writes its files to the current directory unless told otherwise.
  if (sub === "format-patch" && !rest.includes("--stdout") && outputs?.length === 0)
    return refuse("git format-patch without --stdout or -o (it writes patch files to the current directory)")
  if (outputs === undefined) return refuse(`git ${sub} with an output path that is missing or cannot be checked`)
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
      // Read-only forms only: bare, get-url <name> and show -n <name>, after any leading -v.
      let args = rest
      while (args[0] === "-v" || args[0] === "--verbose") args = args.slice(1)
      const ok =
        args.length === 0 ||
        (args[0] === "get-url" && args.length === 2 && !(args[1] as string).startsWith("-")) ||
        (args[0] === "show" && args[1] === "-n" && args.length === 3 && !(args[2] as string).startsWith("-"))
      if (!ok) return refuse("git remote changes or contacts remotes")
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
    case "apply":
      // --directory and --unsafe-paths let a patch land outside the work tree it runs in.
      if (rest.some((arg) => longOption(arg, "--directory") || longOption(arg, "--unsafe-paths"))) return refuse("git apply with --directory or --unsafe-paths")
      break
    case "fetch": {
      // Only remote-tracking refs may be written: no HEAD updates, no forced or local-branch refspecs.
      if (rest.some((arg) => longOption(arg, "--update-head-ok") || longOption(arg, "--refmap") || cluster(arg, "u")))
        return refuse("git fetch with --update-head-ok, -u or --refmap")
      const refspecs = rest.filter((arg) => !arg.startsWith("-")).slice(1)
      const bad = refspecs.find((spec) => spec.startsWith("+") || (spec.includes(":") && !(spec.split(":").pop() ?? "").startsWith("refs/remotes/")))
      if (bad !== undefined) return refuse(`git fetch with the refspec ${bad}`)
      break
    }
    case "stash":
      // Stash refs are shared by every worktree, so drop, clear, pop and apply could delete or apply someone else's work.
      if (rest[0] !== undefined && !rest[0].startsWith("-") && !["list", "show", "push", "save"].includes(rest[0]))
        return refuse(`git stash ${rest[0]}`)
      break
    case "worktree": {
      // Only list for refactor; debug may add and remove its own scratch worktrees. lock, move, repair and prune touch shared metadata.
      const action = rest[0] ?? ""
      if (!(action === "list" || (agent === "debug" && (action === "add" || action === "remove")))) return refuse(`git worktree ${action}`)
      if (action === "add" || action === "remove") {
        const target = worktreeTarget(action, rest.slice(1))
        const resolved = target === undefined || unsafeOperand(target) ? undefined : joinPath(tree, target, ctx.env.home)
        if (resolved === undefined || !scratchRoot(resolved, ctx)) return refuse(`git worktree ${action} on a path other than a debug-* scratch worktree directory`)
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
  if (unsafeOperand(first)) return refuse(`${first}: a variable or glob in the command cannot be checked`)
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
  const resolved = unsafeOperand(script) ? undefined : joinPath(tree, script, ctx.env.home)
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
    case "format-patch":
      return !rest.includes("--stdout")
    case "stash":
      return !["list", "show"].includes(rest[0] ?? "")
    case "branch":
      return (
        rest.some((arg) => !arg.startsWith("-")) &&
        !rest.some((arg) => ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"].includes(arg))
      )
    case "bisect":
      return !["log", "visualize", "view", "terms"].includes(rest[0] ?? "")
    default:
      return false
  }
}

/** A branch the debug agent owns: exactly `debug/<slug>` or `debug-<slug>`. */
const DEBUG_BRANCH = /^(?!.*\.\.)debug[-/][A-Za-z0-9._-]+$/
/** A start point that cannot be a branch the user owns: a full object id or a remote-tracking ref. */
const START_POINT = /^(?!.*\.\.)(?:[0-9a-f]{40}|[0-9a-f]{64}|origin\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/

const same = (args: readonly string[], form: ReadonlyArray<string | ((word: string) => boolean)>) =>
  args.length === form.length && form.every((expected, i) => (typeof expected === "string" ? args[i] === expected : expected(args[i] as string)))
const branch = (word: string) => DEBUG_BRANCH.test(word)
const start = (word: string) => START_POINT.test(word)
const anyWord = (word: string) => !word.startsWith("-")

/** Whether `args` is exactly one of the forms, an optional trailing start point included. */
const oneOf = (args: readonly string[], ...forms: ReadonlyArray<ReadonlyArray<string | ((word: string) => boolean)>>) =>
  forms.some((form) => same(args, form) || same(args, [...form, start]))

/**
 * A branch-changing command is allowed in exactly these token-for-token forms, so no abbreviation, cluster,
 * attached value or extra option can reach a branch the user owns. `change` says the command is one of them;
 * `why` says it is branch-changing but not an allowed form.
 */
function branchForm(sub: string, rest: readonly string[]): { change?: true; why?: string } {
  const refused = (what: string, use: string) => ({ why: `git ${sub} ${what} is not an allowed form; ${use}` })
  if (sub === "switch") {
    if (oneOf(rest, ["-c", branch], ["--create", branch], ["--detach"]) || same(rest, [branch])) return { change: true }
    return refused(rest.join(" "), "use git switch -c debug/<slug> [<start>], git switch debug/<slug>, or git switch --detach [<start>]")
  }
  if (sub === "checkout") {
    if (oneOf(rest, ["--detach"]) || same(rest, [branch])) return { change: true }
    return refused(rest.join(" "), "use git switch (for branches) or git restore -- <paths> (for files)")
  }
  if (sub === "branch" && changesTree(sub, rest)) return refused(rest.join(" "), "create a branch with git switch -c debug/<slug>")
  if (sub === "bisect" && rest[0] === "reset" && rest.length > 1 && !same(rest.slice(1), [branch]) && !same(rest.slice(1), [(w) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(w)]))
    return refused(rest.join(" "), "use git bisect reset with a debug/<slug> branch or a full object id")
  return {}
}

/** `git worktree add` in exactly `--detach <path> [<start>]` or `-b debug[-/]<slug> <path> [<start>]`. */
function worktreeAddForm(args: readonly string[]): boolean {
  return oneOf(args, ["--detach", anyWord]) || oneOf(args, ["-b", branch, anyWord])
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

/** Whether `path` is exactly a debug scratch worktree directory for this session. */
function scratchRoot(path: string, ctx: Ctx): boolean {
  return ctx.env.startDir !== undefined && isScratchRoot(path, { home: ctx.env.home, startDir: ctx.env.startDir })
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
    if (value === undefined || value === "" || unsafeOperand(value)) return undefined
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
  /** The current directory, unknown once `cd` ran, and whether any `cd` ran. Shared by the commands of one line. */
  state: { cwd: string | undefined; moved: boolean }
  /** Counts of the mutating git subcommands the guard accepted, and how many of them change the branch. Shared by every nested check. */
  report: { mutating: number; branch: number }
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
    return checkGit(args, ctx, cwd, directories.length > 0)
  }
  if (inlineCode(exe, args).some((code) => MENTIONS_GIT.test(code)))
    return "an interpreter running inline code that mentions git cannot be checked"
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

/** Note `cd`, `pushd` and `popd`: from then on the directory of later commands is not the shell's `workdir`. */
function followDirectory(position: CommandPosition, ctx: Ctx): boolean {
  const { argv } = realCommand(position.argv)
  if (!["cd", "pushd", "popd"].includes(basename(argv[0] ?? ""))) return false
  ctx.state.cwd = undefined
  ctx.state.moved = true
  return true
}

function checkParsed(parsed: ParsedCommand, ctx: Ctx): string | undefined {
  for (const position of parsed.commands as CommandPosition[]) {
    if (followDirectory(position, ctx)) continue
    const reason = checkWords(position.argv, ctx)
    if (reason !== undefined) return reason
  }
  for (const child of parsed.nested) {
    const reason = checkParsed(child, { ...deeper(ctx), state: { ...ctx.state } })
    if (reason !== undefined) return reason
  }
  return undefined
}

function checkCommand(command: string, ctx: Ctx): string | undefined {
  const text = unbackslash(command.replace(/['"]/g, ""))
  if (!WORTH_PARSING.test(text)) return undefined
  const parsed = parse(command)
  if (parsed.unknown) return MENTIONS_GIT.test(text) || ctx.mentions ? "the command could not be parsed, so its git use cannot be checked" : undefined
  return checkParsed(parsed, { ...ctx, mentions: ctx.mentions || MENTIONS_GIT.test(text), state: { ...ctx.state } })
}

/** The directory a shell call starts in: its `workdir` against the session's start directory. */
function startingDirectory(env: GitContext): string | undefined {
  if (env.workdir !== undefined && isAbsolute(env.workdir)) return env.workdir
  if (env.startDir === undefined) return undefined
  return env.workdir === undefined ? env.startDir : joinPath(env.startDir, env.workdir, env.home)
}

/** The verdict on a command line, and whether it holds a mutating git subcommand (debug only) that passed. */
export type GitInspection = { reason?: string; mutates: boolean }

export function inspectGit(command: string, agent: string, env: GitContext = {}): GitInspection {
  const policy = POLICIES[agent]
  if (policy === undefined) return { mutates: false }
  const report = { mutating: 0, branch: 0 }
  const reason = checkCommand(command, {
    agent,
    policy,
    mentions: false,
    depth: 0,
    env,
    state: { cwd: startingDirectory(env), moved: false },
    report,
  })
  if (reason !== undefined) return { reason, mutates: false }
  // The HEAD check reads HEAD before the call, so a call that moves HEAD may not also change anything else.
  if (report.branch > 0 && report.mutating > 1)
    return { reason: "a branch change and another mutating git command in one call; run the branch change in its own call", mutates: false }
  // A branch change can only reach a debug branch or a detached HEAD, so it does not need the HEAD check.
  return { mutates: report.mutating > 0 && report.branch === 0 }
}

/** Why `command` is refused for `agent`, or undefined when it may run. */
export function forbiddenGit(command: string, agent: string, env: GitContext = {}): string | undefined {
  return inspectGit(command, agent, env).reason
}

/**
 * `forbiddenGit` for a shell tool call, read the way the host reads it: an alias such as `bash`
 * with an argv-array command is normalised first, so the guard sees the same string that runs.
 * A shell call whose input has no recognisable command is refused for guarded agents, because
 * another hook may rewrite it into one.
 */
export function inspectShellCall(tool: string, input: unknown, agent: string, env: GitContext = {}): GitInspection & { workdir?: string } {
  if (POLICIES[agent] === undefined || !isShellTool(tool)) return { mutates: false }
  const call = shellCall(tool, input)
  if (call === undefined || call.command.trim() === "")
    return { reason: "the shell input has no recognisable command, so its git use cannot be checked", mutates: false }
  const merged = { ...env, workdir: call.workdir ?? env.workdir }
  return { ...inspectGit(call.command, agent, merged), workdir: startingDirectory(merged) }
}

export function guardShellCall(tool: string, input: unknown, agent: string, env: GitContext = {}): string | undefined {
  return inspectShellCall(tool, input, agent, env).reason
}
