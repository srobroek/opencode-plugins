/**
 * The `op-guard` gate: the 1Password CLI `op` called directly, and fnox commands that print
 * secret values. fnox reads 1Password through its daemon cache; a direct `op` call opens a new
 * 1Password session and prompts the user.
 */

import { base, type Command, hasFlag, positionals, SHELLS, walkShell } from "./shell.ts"

export const OP_MESSAGE =
  "safety op-guard: do not call the 1Password CLI directly; each call opens a new 1Password session and asks the user to approve. Run the command through fnox, which reuses its cached session: `fnox exec -- <cmd>`, or `fnox exec --only NAME -- <cmd>`. If the secret is not declared, load the `project-secrets` skill and declare it; if it does not exist yet, ask the user to create it. To find items, run `fnox provider discover <provider> --tags project/<name>`."

export const FNOX_DUMP_MESSAGE =
  "safety op-guard: this fnox command prints secret values into the transcript. Use `fnox check` or `fnox list` to inspect, and `fnox exec -- <cmd>` to use a value."

const OP_VALUED: ReadonlySet<string> = new Set([
  "--account",
  "--config",
  "--session",
  "--format",
  "--cache",
  "--vault",
  "--encoding",
])

function isOp(name: string): boolean {
  return name === "op" || name === "op.exe"
}

/** Whether a redirection reads input: `<`, `<<`, `<<<`, `<<-`, `<&` or `<>`. */
function readsInput(command: Command): boolean {
  return command.redirects.some((word) => /<[<&>-]?\s*$/.test(command.source.slice(0, word.start)))
}

/** Whether a command's stdin comes from a pipe, a here-document or an input redirection. */
function stdinFed(command: Command): boolean {
  return command.stage > 0 || command.hereDocuments.length > 0 || readsInput(command)
}

/** Whether an `op item create` call sets a field value: an assignment, a password, a template or stdin. */
function setsFieldValues(command: Command, args: readonly string[], fed: boolean): boolean {
  if (fed || stdinFed(command)) return true
  return args.some(
    (arg) =>
      arg === "-" ||
      arg === "--template" ||
      arg.startsWith("--template=") ||
      arg === "--generate-password" ||
      arg.startsWith("--generate-password=") ||
      (!arg.startsWith("-") && arg.includes("=")),
  )
}

/** The words of `allow` (such as "vault list") match the start of the subcommand words. */
function allowed(words: readonly string[], allow: readonly string[]): boolean {
  return allow.some((entry) => {
    const prefix = entry.trim().split(/\s+/).filter(Boolean)
    return prefix.length > 0 && prefix.every((word, i) => words[i] === word)
  })
}

/** An `op` call that is not one of the read-only or empty-create exceptions nor in `allow`. */
export function opCall(command: Command, allow: readonly string[] = [], fed = false): boolean {
  if (!isOp(base(command.argv[0]))) return false
  const args = command.argv.slice(1)
  if (args.includes("--help") || args.includes("-h")) return false
  if (args.length === 1 && args[0] === "--version") return false
  const words = positionals(args, OP_VALUED)
  if (words[0] === "whoami") return false
  if (words[0] === "item" && words[1] === "create" && !setsFieldValues(command, args, fed)) return false
  if (words[0] === "vault" && words[1] === "create" && words[2] !== undefined) return false
  return !allowed(words, allow)
}

const FNOX_VALUED: ReadonlySet<string> = new Set(["-P", "--profile", "-c", "--config", "--age-key-file"])
/** `env`, `printenv`, a bare `set`, `export -p` or `declare -x` printing the environment. */
function dumpsEnvironment(command: Command): boolean {
  // The walk drops wrappers, so a bare `env` (possibly behind `timeout 5` or `sudo -u x`) has no argv left.
  if (command.argv.length === 0) return command.wrappers.at(-1) === "env"
  const name = base(command.argv[0])
  const args = command.argv.slice(1)
  if (name === "printenv") return true
  if (name === "set") return args.length === 0
  if (name === "export") return hasFlag(args, "p", [])
  if (name === "declare" || name === "typeset") return hasFlag(args, "x", [])
  return false
}

function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/** The command a `fnox exec` runs: after `--`, else its first positional onward. */
function execInner(args: readonly string[]): string[] {
  const dash = args.indexOf("--")
  if (dash >= 0) return args.slice(dash + 1)
  const valued = new Set(["--only", "-i", "--if-missing", "-P", "--profile", "-c", "--config"])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith("-")) return args.slice(i)
    if (valued.has(arg)) i++
  }
  return []
}

/** What `fnox` does with this command: dump values, or run an inner command that is refused. */
export function fnoxRefusal(
  command: Command,
  allow: readonly string[] = [],
  inheritedStdin = false,
): "op" | "dump" | undefined {
  if (base(command.argv[0]) !== "fnox") return undefined
  const argv = command.argv
  let at = 1
  for (; at < argv.length; at++) {
    const word = argv[at] as string
    const [flag] = word.split("=", 1) as [string]
    if (FNOX_VALUED.has(flag)) {
      if (!word.includes("=")) at++
      continue
    }
    if (word.startsWith("-")) continue
    break
  }
  const sub = argv[at]
  const args = argv.slice(at + 1)
  if (sub === "get" || sub === "export" || sub === "env") return "dump"
  if (sub === "list" || sub === "ls" || sub === "secrets")
    return hasFlag(args, "V", ["--values"]) ? "dump" : undefined
  if (sub !== "exec") return undefined
  const inner = execInner(args)
  if (inner.length === 0) return undefined
  // The child inherits fnox's stdin, so a fed `op item create` may carry field values.
  const fed = inheritedStdin || stdinFed(command)
  const children = walkShell(inner.map(quote).join(" ")).commands
  // A here-document fed to a shell started by fnox is that shell's script.
  const scripts = SHELLS.has(base(inner[0])) && !inner.some((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
  const bodies = scripts ? command.hereDocuments.flatMap((document) => walkShell(document.body).commands) : []
  for (const nested of [...children, ...bodies]) {
    if (dumpsEnvironment(nested)) return "dump"
    if (opCall(nested, allow, fed)) return "op"
    const again = fnoxRefusal(nested, allow, fed)
    if (again !== undefined) return again
  }
  return undefined
}

/** The op-guard verdict for a call's commands, or `undefined`. */
export function opGuard(commands: readonly Command[], allow: readonly string[] = []): string | undefined {
  for (const command of commands) {
    if (opCall(command, allow)) return OP_MESSAGE
    const fnox = fnoxRefusal(command, allow)
    if (fnox === "op") return OP_MESSAGE
    if (fnox === "dump") return FNOX_DUMP_MESSAGE
  }
  return undefined
}
