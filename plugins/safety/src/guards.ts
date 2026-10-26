/**
 * Hard gates: shell calls the plugin refuses before they run. Each gate reads the
 * commands `walkShell` finds, so a hazard quoted as data (`grep 'rm -rf $X'`, a commit
 * message, a here-document written to a file) never trips it, while one run through
 * `sudo`, `bash -c`, `eval`, `xargs` or a substitution does.
 */

import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { hasAttribution } from "./attribution.ts"
import {
  base,
  type Command,
  expandsParameter,
  gitInvocation,
  hasFlag,
  positionals,
  SHELLS,
  walkShell,
  wordText,
  wtInvocation,
} from "./shell.ts"

export type GuardID = "indirection" | "remote-exec" | "attribution" | "worktree-tmp" | "git-defender"

export const GUARD_IDS: readonly GuardID[] = ["indirection", "remote-exec", "attribution", "worktree-tmp", "git-defender"]

export type Refusal = { guard: GuardID; reason: string }

export const MESSAGES: Record<GuardID, string> = {
  indirection:
    "Blocked by safety (bash-indirection-guard): this destructive command targets an unexpanded variable, command substitution, or backtick expression, so its path cannot be verified. Resolve the target and re-issue a literal command; a quoted variable is accepted only after a bare `--` end-of-options marker.",
  "remote-exec":
    "Blocked by safety (remote-exec-guard): this command would execute content fetched from the network without review: a download piped into a shell, a shell or `eval` running a fetch's output, or a netcat invocation with an exec flag. Download to a file, inspect it, and run only an explicitly reviewed script.",
  attribution:
    "Blocked by safety (attribution-guard): this commit message carries AI-assistant attribution (a Co-authored-by trailer naming an assistant, a 'Generated with' line, or an assistant noreply address). Rewrite the `-m`/`--message` text, the `--trailer`, or the file supplied to `-F`/`--file`, so the commit names only the human author.",
  "worktree-tmp":
    "Blocked by safety (worktree-tmp-guard): do not create a worktree under /tmp or /private/tmp, where a container bind mount cannot see it. Use a path under $HOME, such as ~/tmp/worktrees/<repo>/<branch>.",
  "git-defender":
    "Blocked by safety (git-defender-user-only): only the user runs the Git Defender CLI. It acts under the user's corporate identity, so every subcommand is refused, read-looking ones included. Name the exact command you would have run and why, hand it to the user to run in their own terminal, and report the outcome you needed as unknown. Do not retry through eval, a wrapper, a script or a subagent.",
}

const DESTRUCTIVE: ReadonlySet<string> = new Set(["rm", "rmdir", "dd", "shred", "truncate", "unlink", "wipefs"])

function destructive(name: string): boolean {
  return DESTRUCTIVE.has(name) || /^mkfs(?:\.[A-Za-z0-9]+)?$/.test(name)
}

/** Whether the word's source has a `$` or backtick outside quotes. */
function unquotedExpansion(text: string): boolean {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "\\" && quote !== "'") {
      i++
      continue
    }
    if (quote) {
      if (c === quote) quote = undefined
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === "$" || c === "`") return true
  }
  return false
}

/** A destructive verb whose operand is an expansion; a quoted variable after `--` is the reviewed idiom. */
export function indirection(command: Command): boolean {
  if (!destructive(base(command.argv[0]))) return false
  let afterEnd = false
  for (let i = 1; i < command.argv.length; i++) {
    const value = command.argv[i] as string
    if (value === "--" && !afterEnd) {
      afterEnd = true
      continue
    }
    if (!expandsParameter(command, i)) continue
    const text = wordText(command, i)
    const substitution = /\$\(|`/.test(value)
    const exempt = afterEnd && !substitution && text !== undefined && !unquotedExpansion(text)
    if (!exempt) return true
  }
  return false
}

const FETCHERS: ReadonlySet<string> = new Set(["curl", "wget", "fetch", "http", "https", "xh"])
const SOURCERS: ReadonlySet<string> = new Set(["source", "."])

/** Whether a word runs a fetch inside a command, process or backtick substitution. */
function substitutesFetch(value: string): boolean {
  if (!/\$\(|`|<\(/.test(value)) return false
  return walkShell(value).commands.some(
    (command) => command.context !== "top" && FETCHERS.has(base(command.argv[0])),
  )
}

function readsStdinScript(command: Command): boolean {
  const args = command.argv.slice(1)
  if (args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) return false
  return true
}

function netcatExec(command: Command): boolean {
  const name = base(command.argv[0])
  if (name !== "nc" && name !== "ncat" && name !== "netcat") return false
  const args = command.argv.slice(1)
  if (hasFlag(args, undefined, ["--exec", "--sh-exec", "--lua-exec"])) return true
  return args.some((arg) => /^-[A-Za-z]*e[A-Za-z]*$/.test(arg) || (name === "ncat" && /^-[A-Za-z]*c$/.test(arg)))
}

/** A fetch piped into a shell, a shell or `eval` running a fetch's output, or `nc -e`. */
export function remoteExec(commands: readonly Command[]): boolean {
  for (const command of commands) {
    const name = base(command.argv[0])
    if (netcatExec(command)) return true
    if (command.argv[0] !== undefined && substitutesFetch(command.argv[0])) return true
    if (
      (SHELLS.has(name) || SOURCERS.has(name) || name === "eval") &&
      command.argv.some((value, i) => i > 0 && command.words?.[i]?.expands !== false && substitutesFetch(value))
    )
      return true
    if (!FETCHERS.has(name)) continue
    const downstream = commands.filter((other) => other.pipeline === command.pipeline && other.stage > command.stage)
    if (downstream.some((other) => SHELLS.has(base(other.argv[0])) && readsStdinScript(other))) return true
  }
  return false
}

export { hasAttribution }

/** The `-m`/`--message`/`--trailer` texts and `-F`/`--file` paths of a `git commit`. */
export function commitMessage(args: readonly string[]): { texts: string[]; files: string[] } {
  const texts: string[] = []
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === "--") break
    if (arg.startsWith("--")) {
      const [flag] = arg.split("=", 1) as [string]
      const value = arg.includes("=") ? arg.slice(flag.length + 1) : undefined
      const take = () => value ?? args[++i]
      if (flag === "--message" || flag === "--trailer") {
        const text = take()
        if (text !== undefined) texts.push(text)
      } else if (flag === "--file") {
        const file = take()
        if (file !== undefined) files.push(file)
      } else if (["--author", "--date", "--cleanup", "--fixup", "--squash", "--reuse-message", "--reedit-message"].includes(flag) && value === undefined) {
        i++
      }
      continue
    }
    if (!arg.startsWith("-") || arg === "-") continue
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]
      if (letter !== "m" && letter !== "F" && letter !== "c" && letter !== "C") continue
      const rest = arg.slice(j + 1)
      const value = rest !== "" ? rest : args[++i]
      if (value === undefined) break
      if (letter === "m") texts.push(value)
      else if (letter === "F") files.push(value)
      break
    }
  }
  return { texts, files }
}

export type FileReader = (path: string) => string | undefined

const readText: FileReader = (path) => {
  try {
    return readFileSync(path, "utf8").slice(0, 1_000_000)
  } catch {
    return undefined
  }
}

/** What earlier commands in the call write into `path`: their words, here-strings and here-document bodies. */
function writtenInto(commands: readonly Command[], before: Command, path: string, cwd: string): string[] {
  const out: string[] = []
  const target = isAbsolute(path) ? path : resolve(cwd, path)
  for (const command of commands) {
    if (command.index >= before.index && command.source === before.source) break
    const writes = command.redirects.some((word) => {
      const value = word.value
      return value === path || (!isAbsolute(value) ? resolve(cwd, value) : value) === target
    })
    const tee = base(command.argv[0]) === "tee" && command.argv.slice(1).includes(path)
    if (!writes && !tee) continue
    out.push(command.argv.join(" "), ...command.redirects.map((word) => word.value))
    out.push(...command.hereDocuments.map((document) => document.body))
    // `printf … | tee FILE` writes what the earlier stages print.
    for (const stage of commands)
      if (stage.pipeline === command.pipeline && stage.stage < command.stage) out.push(stage.argv.join(" "))
  }
  return out
}

/** A `git commit` whose message carries AI-assistant attribution. */
export function attribution(commands: readonly Command[], cwd: string, read: FileReader = readText): boolean {
  for (const command of commands) {
    const git = gitInvocation(command.argv)
    if (git?.subcommand !== "commit") continue
    const { texts, files } = commitMessage(git.args)
    if (texts.some(hasAttribution)) return true
    for (const file of files) {
      const sources: string[] = []
      if (file === "-") {
        sources.push(...command.hereDocuments.map((document) => document.body))
        sources.push(...command.redirects.map((word) => word.value))
        for (const stage of commands)
          if (stage.pipeline === command.pipeline && stage.stage < command.stage) {
            sources.push(stage.argv.join(" "), ...stage.hereDocuments.map((document) => document.body))
          }
      } else {
        const dir = git.chdirs.reduce((at, chdir) => resolve(at, chdir), cwd)
        const content = read(isAbsolute(file) ? file : resolve(dir, file))
        if (content !== undefined) sources.push(content)
        sources.push(...writtenInto(commands, command, file, dir))
      }
      if (sources.some(hasAttribution)) return true
    }
  }
  return false
}

function underTmp(path: string): boolean {
  return /^(?:\/private)?\/tmp(?:\/|$)/.test(path)
}

const WORKTREE_ADD_VALUED: ReadonlySet<string> = new Set(["-b", "-B", "--reason"])

/** `git worktree add` or `wt switch|new|co|agent` placing a worktree under `/tmp`. */
export function worktreeTmp(command: Command, cwd: string): boolean {
  const git = gitInvocation(command.argv)
  if (git?.subcommand === "worktree" && git.args[0] === "add") {
    const dir = git.chdirs.reduce((at, chdir) => resolve(at, chdir), cwd)
    const path = positionals(git.args.slice(1), WORKTREE_ADD_VALUED)[0]
    if (path === undefined || path.startsWith("~") || path.startsWith("$")) return false
    return underTmp(isAbsolute(path) ? path : resolve(dir, path))
  }
  const wt = wtInvocation(command.argv)
  if (wt && ["switch", "new", "co", "agent"].includes(wt.subcommand)) {
    return wt.args.some((arg) => underTmp(arg) || underTmp(arg.slice(arg.indexOf("=") + 1)))
  }
  return false
}

/** The agent running the Git Defender CLI, in any command position. */
export function gitDefender(command: Command): boolean {
  const name = base(command.argv[0])
  if (name === "git-defender") return true
  return gitInvocation(command.argv)?.subcommand === "defender"
}

export type GuardOptions = {
  /** Guards to skip. */
  disabled?: ReadonlySet<GuardID>
  read?: FileReader
}

/** The first hard gate `source` trips, or `undefined`. */
export function hardGate(source: string, cwd: string, options: GuardOptions = {}): Refusal | undefined {
  const on = (guard: GuardID) => options.disabled?.has(guard) !== true
  const { commands } = walkShell(source)
  const refuse = (guard: GuardID): Refusal => ({ guard, reason: MESSAGES[guard] })
  if (on("git-defender") && commands.some(gitDefender)) return refuse("git-defender")
  if (on("remote-exec") && remoteExec(commands)) return refuse("remote-exec")
  if (on("indirection") && commands.some(indirection)) return refuse("indirection")
  if (on("attribution") && attribution(commands, cwd, options.read)) return refuse("attribution")
  if (on("worktree-tmp") && commands.some((command) => worktreeTmp(command, cwd))) return refuse("worktree-tmp")
  return undefined
}
