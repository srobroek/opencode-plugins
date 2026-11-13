/**
 * The `op-guard` gate: the 1Password CLI `op` called directly, and fnox commands that print
 * secret values. fnox reads 1Password through its daemon cache; a direct `op` call opens a new
 * 1Password session and prompts the user.
 */

import type { HereDocument } from "@srobroek/opencode-lib"
import { base, type Command, hasFlag, positionals, SHELLS, walkShell, wordText } from "./shell.ts"

export const OP_MESSAGE =
  "safety op-guard: do not call the 1Password CLI directly; each call opens a new 1Password session and asks the user to approve. Run the command through fnox, which reuses its cached session: `fnox exec -- <cmd>`, or `fnox exec --only NAME -- <cmd>`. If the secret is not declared, load the `project-secrets` skill and declare it; if it does not exist yet, ask the user to create it. To find items, run `fnox provider discover <provider> --tags project/<name>`."

export const FNOX_DUMP_MESSAGE =
  "safety op-guard: this fnox command prints secret values into the transcript. Use `fnox check` or `fnox list` to inspect, and `fnox exec -- <cmd>` to use a value."

export const LITERAL_MESSAGE =
  "safety op-guard: a literal secret in the command lands in the transcript; pass it from a command or variable (`credential=$(cmd)`), or pipe a JSON template to `op item create -`."

export const FNOX_SET_MESSAGE =
  "safety op-guard: pipe the value into `fnox set NAME --provider host` from a command; a literal value lands in the transcript."

export const FNOX_STORE_MESSAGE =
  "safety op-guard: this fnox provider cannot store a value; `fnox set` would write a piped, generated or expanded value into fnox.toml as the item reference. Create the item first, `<json from a command> | op item create --vault V -`, then point fnox at it: `fnox set NAME '<item>/<field>' --provider <op-provider>`."

export const NESTING_MESSAGE =
  "safety op-guard: command nesting is too deep to check; run it without nested shells"

export const CHECK_FAILED_MESSAGE =
  "safety op-guard: could not check this command; run `op` and fnox commands directly, without nesting"

/** Levels of nested scripts, `fnox exec` and wrappers the guard follows before it refuses. */
export const MAX_NESTING = 16

class NestingTooDeep extends Error {}

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

/** Typed fields that hold no secret: a literal value is fine. */
const PLAIN_TYPES: ReadonlySet<string> = new Set(["text", "url", "email", "date", "monthyear", "phone", "delete"])
/** Built-in fields that hold no secret, when written without a type. */
const PLAIN_FIELDS: ReadonlySet<string> = new Set(["username", "url", "notesPlain"])
/** `op item create|edit` options that take the next word, which may itself contain `=`. */
const ITEM_VALUED: ReadonlySet<string> = new Set([...OP_VALUED, "--title", "--category", "--url", "--tags", "--template"])

/** Index just past the `$(…)` that opens at `at` (a `$`), honouring quotes and escapes inside it; -1 if unclosed. */
function commandSubstitutionEnd(text: string, at: number): number {
  let depth = 0
  let quote: string | undefined
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i] as string
    if (c === "\\" && quote !== "'") {
      i++
    } else if (quote) {
      if (c === quote) quote = undefined
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === "(") {
      depth++
    } else if (c === ")" && --depth === 0) {
      return i + 1
    }
  }
  return -1
}

/** Whether `text` (a word's value, quotes removed) is made of expansions only: `$VAR`, `${VAR}`, `$(cmd)`, backticks. */
function onlyExpansions(text: string): boolean {
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const simple = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\}|[0-9@*#?!$-])|^`[^`]*`/.exec(rest)
    if (simple) {
      i += simple[0].length
    } else if (rest.startsWith("$(")) {
      const end = commandSubstitutionEnd(text, i)
      if (end < 0) return false
      i = end
    } else {
      return false
    }
  }
  return true
}

/** Whether word `at` of the command, from character `skip` of its value, is expansions only: no literal text. */
function expansionOnly(command: Command, at: number, skip = 0): boolean {
  return command.words?.[at]?.expands !== false && onlyExpansions((command.argv[at] as string).slice(skip))
}

/** Whether a here-document or here-string feeds literal text, with no expansion to fill in a value. */
function literalStdin(command: Command): boolean {
  return (
    command.hereDocuments.some((document) => document.quoted || !/[$`]/.test(document.body)) ||
    command.redirects.some((word) => word.hereString === true && !(word.expands && onlyExpansions(word.value)))
  )
}

/** Whether a stage prints literal text into a pipe: `echo`/`printf`, `jq -n --arg`, or `cat` of a literal here-document. */
function literalWriter(command: Command): boolean {
  const name = base(command.argv[0])
  const args = command.argv.slice(1)
  if (name === "cat") return literalStdin(command)
  if (name === "echo") {
    const operands = args.map((_, i) => i + 1).filter((at) => !/^-[neE]+$/.test(command.argv[at] as string))
    return operands.some((at) => !expansionOnly(command, at))
  }
  if (name === "printf") {
    const operands = args.map((_, i) => i + 1).filter((at) => (command.argv[at] as string) !== "--")
    const [format, ...fill] = operands
    if (format === undefined) return false
    // Drop conversions and escapes; any letter or digit left is literal text.
    const text = (command.argv[format] as string)
      .replace(/%(?:%|[-+ #0]*\d*(?:\.\d+)?[A-Za-z])/g, "")
      .replace(/\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|.)/g, "")
    if (/[A-Za-z0-9]/.test(text) && !expansionOnly(command, format)) return true
    return fill.some((at) => !expansionOnly(command, at))
  }
  if (name === "jq") {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--arg" || args[i] === "--argjson") {
        if (!expansionOnly(command, i + 3)) return true
        i += 2
      }
    }
  }
  return false
}

/** Whether the command's stdin carries literal text: a literal here-document, or an upstream stage that prints one. */
function literalFed(command: Command, commands: readonly Command[]): boolean {
  return (
    literalStdin(command) ||
    commands.some((other) => other.pipeline === command.pipeline && other.stage < command.stage && literalWriter(other))
  )
}

/** Whether `op item create|edit` writes a literal value into a field that may be a secret. */
function literalSecret(command: Command, args: readonly string[], inheritedLiteral: boolean): boolean {
  if (inheritedLiteral || literalStdin(command)) return true
  const offset = command.argv.length - args.length
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (ITEM_VALUED.has(arg)) {
      i++
      continue
    }
    const eq = arg.indexOf("=")
    if (arg.startsWith("-") || eq < 0) continue
    if (eq === arg.length - 1) continue
    if (expansionOnly(command, offset + i, eq + 1)) continue
    const field = arg.slice(0, eq)
    const typed = /^(.*)\[([^\]]*)\]$/.exec(field)
    if (typed ? PLAIN_TYPES.has((typed[2] as string).toLowerCase()) : PLAIN_FIELDS.has(field)) continue
    return true
  }
  return false
}

/** The words of `allow` (such as "vault list") match the start of the subcommand words. */
function allowed(words: readonly string[], allow: readonly string[]): boolean {
  return allow.some((entry) => {
    const prefix = entry.trim().split(/\s+/).filter(Boolean)
    return prefix.length > 0 && prefix.every((word, i) => words[i] === word)
  })
}

/**
 * Why an `op` call is refused: `op` for any call but the exceptions, `literal` for an item write that puts
 * a possible secret in the command text. `item create|edit`, `whoami`, `vault create <name>`, help, `--version`
 * and the `allow` prefixes pass. `inheritedLiteral`: a `fnox exec` parent feeds the call literal stdin.
 */
export function opRefusal(command: Command, allow: readonly string[] = [], inheritedLiteral = false): "op" | "literal" | undefined {
  if (!isOp(base(command.argv[0]))) return undefined
  const args = command.argv.slice(1)
  if (args.includes("--help") || args.includes("-h")) return undefined
  if (args.length === 1 && args[0] === "--version") return undefined
  const words = positionals(args, OP_VALUED)
  if (words[0] === "whoami") return undefined
  if (words[0] === "item" && (words[1] === "create" || words[1] === "edit")) {
    if (args.some((arg) => arg === "--reveal" || arg.startsWith("--reveal="))) return "op"
    return literalSecret(command, args, inheritedLiteral) ? "literal" : undefined
  }
  if (words[0] === "vault" && words[1] === "create" && words[2] !== undefined) return undefined
  // Names and ids only, no item content.
  if (words[0] === "vault" && words[1] === "list") return undefined
  return allowed(words, allow) ? undefined : "op"
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

/** The commands of `source`; throws when the walk is unfinished and the text names `op` or `fnox`. */
function walkComplete(source: string): Command[] {
  const walk = walkShell(source)
  if (!walk.complete && /\b(?:op|fnox)\b/.test(source)) throw new NestingTooDeep()
  return walk.commands
}

function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/** Index in `args` where the command a `fnox exec` runs begins: after `--`, else the first positional; -1 if none. */
function execInner(args: readonly string[]): number {
  const dash = args.indexOf("--")
  if (dash >= 0) return dash + 1 < args.length ? dash + 1 : -1
  const valued = new Set(["--only", "-i", "--if-missing", "-P", "--profile", "-c", "--config"])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith("-")) return i
    if (valued.has(arg)) i++
  }
  return -1
}

export type Verdict = "op" | "dump" | "literal" | "set" | "store"

const SET_VALUED: ReadonlySet<string> = new Set([
  "-d",
  "--description",
  "-k",
  "--key-name",
  "-p",
  "--provider",
  "--default",
  "--file",
  "--from-file",
  "--generate-type",
  "--if-missing",
  "--length",
  "--source",
])

/** Providers that keep a pasted value in the config or on the host: `host`, and names with an `age` or `keychain` part. */
function plainProvider(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === "host" || lower.split(/[-_.:]/).some((part) => part === "age" || part === "keychain")
}

/**
 * `fnox set` with a provider that stores what it is given and a value in the command text: a literal
 * positional or `--default` (`set`), or a stdin value fed from a literal (`literal`).
 */
function fnoxSetRefusal(command: Command, at: number, fed: boolean): "set" | "literal" | "store" | undefined {
  const args = command.argv.slice(at + 1)
  let provider: string | undefined
  let reads = true
  let generates = false
  const positional: number[] = []
  const defaults: { at: number; skip: number }[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === "--provider" || arg === "-p") provider = args[++i]
    else if (arg.startsWith("--provider=")) provider = arg.slice("--provider=".length)
    else if (arg.startsWith("-p") && !arg.startsWith("--")) provider = arg.slice(2)
    else if (arg === "--default") defaults.push({ at: at + 1 + ++i, skip: 0 })
    else if (arg.startsWith("--default=")) defaults.push({ at: at + 1 + i, skip: "--default=".length })
    else if (arg === "--generate" || arg === "--from-file" || arg.startsWith("--from-file=")) {
      reads = false
      if (arg === "--generate") generates = true
      if (arg === "--from-file") i++
    } else if (SET_VALUED.has(arg)) i++
    else if (!arg.startsWith("-") || arg === "-") positional.push(at + 1 + i)
  }
  if (provider === undefined || !plainProvider(provider)) {
    // No value store: a value from stdin, `--generate` or an expansion would become the item reference.
    const piped = command.stage > 0 || command.hereDocuments.length > 0 || command.redirects.some((word) => word.hereString === true)
    const expanded = positional[1] !== undefined && expansionOnly(command, positional[1])
    if (generates || expanded || (positional[1] === undefined && reads && (fed || piped))) return "store"
    return undefined
  }
  // KEY, then VALUE: a second positional that is not an expansion is a literal.
  const value = positional[1]
  const defaultLiteral = defaults.some((d) => !expansionOnly(command, d.at, d.skip))
  if (value !== undefined) return expansionOnly(command, value) && !defaultLiteral ? undefined : "set"
  if (defaultLiteral) return "set"
  return reads && fed ? "literal" : undefined
}

/** What `fnox` does with this command: dump values, or run an inner command that is refused. */
export function fnoxRefusal(
  command: Command,
  allow: readonly string[] = [],
  inherited: { literal: boolean; documents: readonly HereDocument[]; depth: number } = {
    literal: false,
    documents: [],
    depth: 0,
  },
): Verdict | undefined {
  if (inherited.depth > MAX_NESTING) throw new NestingTooDeep()
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
  if (sub === "set" || sub === "s") return fnoxSetRefusal(command, at, inherited.literal || literalStdin(command))
  if (sub !== "exec") return undefined
  const start = execInner(args)
  if (start < 0) return undefined
  const first = at + 1 + start
  // Rebuild the child from its source words so an expansion stays an expansion.
  const inner = argv.slice(first)
  // The child inherits fnox's stdin and here-documents, through wrappers and nested fnox.
  const documents = [...inherited.documents, ...command.hereDocuments]
  const literal = inherited.literal || literalStdin(command)
  const children = walkComplete(inner.map((word, i) => wordText(command, first + i) ?? quote(word)).join(" "))
  // A here-document fed to the shell left after the wrappers is that shell's script. The shell
  // reads all of stdin, so a parsed document is consumed: an inner level never gets it again.
  const scripts = children
    .filter((nested) => nested.context === "top" && SHELLS.has(base(nested.argv[0])))
    .filter((nested) => !nested.argv.some((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word)))
  const bodies = scripts.length === 0 ? [] : documents.flatMap((document) => walkComplete(document.body))
  const rest = scripts.length === 0 ? documents : []
  const check = (nested: Command, fed: boolean): Verdict | undefined => {
    if (dumpsEnvironment(nested)) return "dump"
    const op = opRefusal(nested, allow, fed)
    if (op !== undefined) return op
    return fnoxRefusal(nested, allow, { literal: fed, documents: rest, depth: inherited.depth + 1 })
  }
  for (const nested of children) {
    const found = check(nested, literal || literalFed(nested, children))
    if (found !== undefined) return found
  }
  for (const nested of bodies) {
    const found = check(nested, literalFed(nested, bodies))
    if (found !== undefined) return found
  }
  return undefined
}

const MESSAGES: Record<Verdict, string> = {
  op: OP_MESSAGE,
  dump: FNOX_DUMP_MESSAGE,
  literal: LITERAL_MESSAGE,
  set: FNOX_SET_MESSAGE,
  store: FNOX_STORE_MESSAGE,
}

/** The op-guard verdict for a call's commands, or `undefined`. Fails closed when its own analysis throws. */
export function opGuard(commands: readonly Command[], allow: readonly string[] = []): string | undefined {
  try {
    for (const command of commands) {
      const fed = literalFed(command, commands)
      const found = opRefusal(command, allow, fed) ?? fnoxRefusal(command, allow, { literal: fed, documents: [], depth: 0 })
      if (found !== undefined) return MESSAGES[found]
    }
    return undefined
  } catch (error) {
    return error instanceof NestingTooDeep ? NESTING_MESSAGE : CHECK_FAILED_MESSAGE
  }
}
