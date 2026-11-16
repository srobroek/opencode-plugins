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
 */

import { commandWords } from "@srobroek/opencode-lib/command-words"
import { type CommandPosition, commandFromInput, type ParsedCommand, parse } from "@srobroek/opencode-lib/shell-command"

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
const DANGEROUS_ENV = /^GIT_(SSH|SSH_COMMAND|EXTERNAL_DIFF|PAGER|EDITOR|ASKPASS|CONFIG[A-Z_]*|EXEC_PATH|PROXY_COMMAND|SEQUENCE_EDITOR)=/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Options that run a command or write to a path chosen by the caller. */
const RISKY_OPTION = /^--(output|upload-pack|receive-pack|exec|open-files-in-pager|ext-diff|textconv)(=|$)/
const MENTIONS_GIT = /git/i

const basename = (word: string) => word.replace(/^\\+/, "").split("/").pop() ?? word
/** Whether `arg` is `--full` or an abbreviation of it git would accept (three characters or more). */
const longOption = (arg: string, full: string) => {
  const name = arg.split("=")[0] ?? arg
  return name.startsWith("--") && name.length >= 3 && full.startsWith(name)
}
/** Whether a short-option cluster such as `-dr` contains one of `letters`. */
const cluster = (arg: string, letters: string) => /^-[^-]/.test(arg) && [...arg.slice(1)].some((c) => letters.includes(c))

/** Why `args` (the words after `git`) is refused for `policy`, or undefined. */
function checkGit(args: readonly string[], agent: string, policy: Policy): string | undefined {
  const refuse = (what: string) => `${what} is not allowed for the ${agent} agent`
  let i = 0
  for (; i < args.length; i++) {
    const word = args[i] as string
    if (!word.startsWith("-")) break
    if (word === "-C" || word === "-c") {
      const value = args[++i]
      if (word === "-c" && (value === undefined || !SAFE_CONFIG.test(value.split("=")[0] ?? ""))) return refuse(`git -c ${value ?? ""}`)
      if (value === undefined) return refuse("git -C without a path")
    } else if (word.startsWith("-C")) {
      // attached path: -Cx
    } else if (word.startsWith("-c")) {
      if (!SAFE_CONFIG.test(word.slice(2).split("=")[0] ?? "")) return refuse(`git ${word}`)
    } else if (word.startsWith("--exec-path")) {
      // --exec-path[=<path>] takes no separate value, but it redirects git's helpers
      return refuse("git --exec-path")
    } else if (BOOLEAN_GLOBALS.has(word)) {
      // no value
    } else if (VALUED_GLOBALS.has(word)) {
      if (args[++i] === undefined) return refuse(`git ${word} without a value`)
    } else if (VALUED_GLOBALS.has(word.split("=")[0] ?? "") && word.includes("=")) {
      // --git-dir=x
    } else return refuse(`git option ${word}`)
  }
  const sub = args[i]
  if (sub === undefined) return undefined
  const rest = args.slice(i + 1)
  if (!policy.subcommands.has(sub)) return refuse(`git ${sub}`)
  const risky = rest.find((arg) => RISKY_OPTION.test(arg) || (sub === "grep" && /^-O/.test(arg)))
  if (risky !== undefined) return refuse(`git ${sub} ${risky}`)
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
    case "worktree":
      if (!["add", "list", "remove", "lock", "unlock", "move", "repair"].includes(rest[0] ?? "")) return refuse(`git worktree ${rest[0] ?? ""}`)
      break
  }
  return undefined
}

/** Words after the xargs/watch/parallel options, as the command they run. */
function runnerCommand(exe: string, args: readonly string[]): string[] {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith("-")) i += exe === "xargs" && XARGS_VALUED.has(args[i] as string) ? 2 : 1
  return args.slice(i)
}

function checkWords(input: readonly string[], agent: string, policy: Policy, depth: number): string | undefined {
  if (depth > 6) return "the command nests too deeply to check its git use"
  const assignments = input.filter((word) => ASSIGNMENT.test(word))
  const { argv } = commandWords(input)
  const first = argv[0]
  if (first === undefined) return undefined
  const exe = basename(first)
  const args = argv.slice(1)
  if (/^[$`]/.test(first) || first.includes("$(")) return "a variable or substitution in command position cannot be checked"
  if (exe === "git") {
    if (assignments.some((word) => DANGEROUS_ENV.test(word))) return `git with ${assignments.find((word) => DANGEROUS_ENV.test(word))} is not allowed for the ${agent} agent`
    return checkGit(args, agent, policy)
  }
  if (SHELLS.has(exe)) {
    const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
    const payload = flag >= 0 ? args[flag + 1] : undefined
    if (payload === undefined) return `a shell reading its script from stdin or a file cannot be checked`
    return checkCommand(payload, agent, policy, depth + 1)
  }
  if (exe === "eval") return checkCommand(args.join(" "), agent, policy, depth + 1)
  if (RUNNERS.has(exe)) return checkWords(runnerCommand(exe, args), agent, policy, depth + 1)
  if (exe === "find") {
    for (let i = 0; i < args.length; i++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i] as string)) continue
      const end = args.findIndex((arg, j) => j > i && (arg === ";" || arg === "+" || arg === "\\;"))
      const reason = checkWords(args.slice(i + 1, end < 0 ? undefined : end), agent, policy, depth + 1)
      if (reason !== undefined) return reason
    }
  }
  return undefined
}

function checkParsed(parsed: ParsedCommand, agent: string, policy: Policy, depth: number): string | undefined {
  for (const position of parsed.commands as CommandPosition[]) {
    const reason = checkWords(position.argv, agent, policy, depth)
    if (reason !== undefined) return reason
  }
  for (const child of parsed.nested) {
    const reason = checkParsed(child, agent, policy, depth + 1)
    if (reason !== undefined) return reason
  }
  return undefined
}

function checkCommand(command: string, agent: string, policy: Policy, depth: number): string | undefined {
  if (!MENTIONS_GIT.test(command.replace(/['"\\]/g, ""))) return undefined
  const parsed = parse(command)
  if (parsed.unknown) return "the command could not be parsed, so its git use cannot be checked"
  return checkParsed(parsed, agent, policy, depth)
}

/** Why `command` is refused for `agent`, or undefined when it may run. */
export function forbiddenGit(command: string, agent: string): string | undefined {
  const policy = POLICIES[agent]
  return policy === undefined ? undefined : checkCommand(command, agent, policy, 0)
}

/** `forbiddenGit` for a shell tool's input. */
export function forbiddenGitInput(input: unknown, agent: string): string | undefined {
  return forbiddenGit(commandFromInput(input), agent)
}
