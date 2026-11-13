/**
 * The `op-guard` gate: the 1Password CLI `op` called directly, and fnox commands that print
 * secret values. fnox reads 1Password through its daemon cache; a direct `op` call opens a new
 * 1Password session and prompts the user.
 */

import { homedir } from "node:os"
import { join } from "node:path"
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

export const FNOX_INDIRECT_MESSAGE =
  "safety op-guard: this command reaches `fnox set` or `op item create|edit` through an executor the guard cannot follow (a piped shell, xargs, find -exec, parallel, env -S, eval, source, an alias or function, an expanded command name, or a launcher such as nix, mise, uv or npx), so it cannot check where the value goes. Run it directly: `<json from a command> | op item create --vault V -`, then `fnox set NAME '<item>/<field>' --provider <op-provider>`."

export const FNOX_CONFIG_MESSAGE =
  "safety op-guard: this command passes a value to `fnox set` and also changes fnox configuration (a write to fnox*.toml or ~/.config/fnox, `fnox config`/`fnox provider` changes, or a write whose target the guard cannot read), so the provider it checked may not be the one used. Change the configuration in one command and run `fnox set` in the next."

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

export type Verdict = "op" | "dump" | "literal" | "set" | "store" | "indirect" | "config"

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
  "-c",
  "--config",
  "-P",
  "--profile",
])

/**
 * fnox provider types that keep a value they are given: encryption in the config (the `*-kms` types,
 * age, FIDO2, YubiKey), a local store (keychain, KeePass, password-store, gopass) or a remote store the
 * fnox docs list as written by `fnox set` (AWS Secrets Manager and Parameter Store, Azure Key Vault
 * Secrets, Google Secret Manager, Bitwarden Secrets Manager, FOKS, HashiCorp Vault). `plain` is left out (it writes the value to fnox.toml in clear text), as are the read-only types (1password and
 * the rest, where `fnox set` records the value as the item reference) and `lua`.
 */
export const VALUE_STORE_TYPES: ReadonlySet<string> = new Set([
  "age",
  "fido2",
  "yubikey",
  "aws-kms",
  "azure-kms",
  "gcp-kms",
  "keychain",
  "keepass",
  "password-store",
  "gopass",
  // Remote stores `fnox set` writes the value to; fnox.toml keeps only a reference.
  "aws-sm",
  "aws-ps",
  "azure-sm",
  "gcp-sm",
  "bitwarden-sm",
  "foks",
  "vault",
])

const DIRECTORY_COMMANDS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir"])
/** Wrappers that take a directory option the walk drops from `argv`. */
const DIRECTORY_WRAPPERS: ReadonlySet<string> = new Set(["env", "sudo", "doas", "chroot", "su", "runuser", "setpriv"])
const DIRECTORY_FLAG = /^(?:-C|-D|--chdir|--cwd|--directory|--working-directory|--workdir|--cd)(?:=|$)/

/**
 * Whether any command could change the directory a later `fnox` runs in: a `cd`, `pushd` or `popd`, a
 * wrapper with a directory option, a `-C`/`--chdir`-style flag, or a command name that is itself an
 * expansion. The config lookup uses the tool call's directory, so it is only right when this is false.
 */
export function changesDirectory(commands: readonly Command[]): boolean {
  return commands.some(
    (command) =>
      command.wrappers.some((wrapper) => DIRECTORY_WRAPPERS.has(wrapper)) ||
      (command.argv.length > 0 &&
        (DIRECTORY_COMMANDS.has(base(command.argv[0])) ||
          /[$`]/.test(command.argv[0] as string) ||
          command.argv.some((word) => DIRECTORY_FLAG.test(word)))),
  )
}

/** The `type` of the fnox provider `name` in the configuration that applies (or in the explicit file `config`), or `undefined` when unknown. */
export type ProviderTypes = (name: string, config?: string) => string | undefined

/** Whether a word holds an expansion, backticks or a process substitution: its value is not known from the text. */
function expands(command: Command, at: number): boolean {
  const word = command.argv[at] as string
  return command.words?.[at]?.expands !== false && /[$`]|[<>]\(/.test(word)
}

/** Whether a `fnox set` takes its value from stdin, a substitution or an expansion rather than a literal. */
function valueSource(command: Command, stdin: boolean, value: number | undefined, defaults: readonly { at: number }[]): boolean {
  const piped = stdin || command.stage > 0 || command.redirects.length > 0 || command.hereDocuments.length > 0
  const substituted = command.argv.some((word) => /[<>]\(/.test(word))
  return piped || substituted || defaults.some((d) => expands(command, d.at)) || (value !== undefined && expands(command, value))
}

const SEARCHED_CONFIGS: ReadonlySet<string> = new Set(["fnox.toml", ".fnox.toml", "fnox.local.toml", ".fnox.local.toml"])

/**
 * The explicit config file a `fnox` command names with `-c`/`--config`: `undefined` for none (or one of
 * the bare names fnox searches for up the tree, which the resolver already reads), the path for a literal
 * file, `null` when the path is an expansion or more than one is given.
 */
function explicitConfig(command: Command): string | null | undefined {
  const found: (string | null)[] = []
  command.argv.forEach((word, at) => {
    if (word === "-c" || word === "--config") {
      const value = command.argv[at + 1]
      found.push(value === undefined || expands(command, at + 1) ? null : value)
    } else if (word.startsWith("--config=")) {
      found.push(expands(command, at) ? null : word.slice("--config=".length))
    }
  })
  if (found.length === 0) return undefined
  const [only] = found
  if (found.length > 1 || only === null || only === undefined) return null
  return SEARCHED_CONFIGS.has(only) ? undefined : only
}

/** The options and positionals of the `fnox set` whose subcommand word is at `at`. */
function parseSet(command: Command, at: number) {
  const args = command.argv.slice(at + 1)
  let provider: string | undefined
  let reads = true
  let sourced = false
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
      sourced = true
      if (arg === "--from-file") i++
    } else if (SET_VALUED.has(arg)) i++
    else if (!arg.startsWith("-") || arg === "-") positional.push(at + 1 + i)
  }
  return { provider, reads, sourced, positional, defaults }
}

/**
 * `fnox set` that would put a value where it must not go. With a provider that stores a value (by its
 * resolved type), a literal positional or `--default` is `set` and a stdin value fed from a literal is
 * `literal`. With any other provider, or none, only the reference form passes: a literal positional
 * (or none, which prompts) with no expansion and no value source (`--generate`, `--from-file`, an expanded `--default`, a pipe,
 * redirect, here-document, here-string, process substitution or stdin inherited from `fnox exec`);
 * everything else is `store`, since fnox would record the value as the item reference in fnox.toml.
 */
function fnoxSetRefusal(
  command: Command,
  at: number,
  fed: boolean,
  stdin: boolean,
  types: ProviderTypes,
  config: string | null | undefined,
): "set" | "literal" | "store" | undefined {
  const { provider, reads, sourced, positional, defaults } = parseSet(command, at)
  const type = provider === undefined || config === null ? undefined : types(provider, config)
  const value = positional[1]
  if (type === undefined || !VALUE_STORE_TYPES.has(type)) {
    // No value and no source is an interactive prompt or a settings update, which stores nothing from the agent.
    return sourced || valueSource(command, stdin, value, defaults) ? "store" : undefined
  }
  const defaultLiteral = defaults.some((d) => !expansionOnly(command, d.at, d.skip))
  // KEY, then VALUE: a second positional that is not an expansion is a literal.
  if (value !== undefined) return expansionOnly(command, value) && !defaultLiteral ? undefined : "set"
  if (defaultLiteral) return "set"
  return reads && fed ? "literal" : undefined
}

const FNOX_VALUED_GLOBAL: ReadonlySet<string> = new Set(["-P", "--profile", "-c", "--config", "--age-key-file"])

/** The subcommand of a `fnox` command and the index of its word, skipping global options. */
function fnoxSubcommand(command: Command): { sub: string; at: number } | undefined {
  if (base(command.argv[0]) !== "fnox") return undefined
  for (let at = 1; at < command.argv.length; at++) {
    const word = command.argv[at] as string
    const [flag] = word.split("=", 1) as [string]
    if (FNOX_VALUED_GLOBAL.has(flag)) {
      if (!word.includes("=")) at++
      continue
    }
    if (word.startsWith("-")) continue
    return { sub: word, at }
  }
  return undefined
}

/** A `fnox set` that takes its value from a source (stdin, a substitution, `--generate`, …), or a `fnox exec` that may run one. */
function setsWithValueSource(command: Command): boolean {
  const found = fnoxSubcommand(command)
  if (found === undefined) return false
  if (found.sub === "exec") return command.argv.includes("set") || command.argv.includes("s")
  if (found.sub !== "set" && found.sub !== "s") return false
  const { sourced, positional, defaults } = parseSet(command, found.at)
  return sourced || valueSource(command, false, positional[1], defaults)
}

const CONFIG_SUBCOMMANDS: ReadonlySet<string> = new Set(["config", "init", "import", "remove", "rm"])
const PROVIDER_CHANGES: ReadonlySet<string> = new Set(["add", "a", "set", "remove", "rm", "delete"])
const FILE_COMMANDS: ReadonlySet<string> = new Set(["tee", "cp", "mv", "ln", "rm", "install", "rsync", "dd", "touch", "truncate", "sed", "perl", "unlink", "shred"])
const CONFIG_FILE = /^\.?fnox(?:\.[^/]+)?\.toml$/
const WRITERS: ReadonlySet<string> = new Set(["tee", "cp", "mv", "ln", "rm", "install", "rsync", "dd", "touch", "truncate", "sed", "perl", "unlink", "shred"])

/** Whether a `fnox` command changes configuration: `config`, `init`, `import`, `remove`, or a `provider` add, set or remove. */
function changesFnoxConfig(command: Command): boolean {
  const found = fnoxSubcommand(command)
  if (found === undefined) return false
  if (CONFIG_SUBCOMMANDS.has(found.sub)) return true
  return found.sub === "provider" && PROVIDER_CHANGES.has(command.argv[found.at + 1] ?? "")
}

/** A write whose target is an expansion the guard cannot read: a redirect, or an argument of a command that writes files. */
function uncertainWrite(command: Command): boolean {
  if (command.redirects.some((word) => word.hereString !== true && word.expands)) return true
  return WRITERS.has(base(command.argv[0])) && command.argv.some((_, at) => at > 0 && expands(command, at))
}

/** A file command (`rm`, `ln`, `mv`, `cp`, `tee`, …) with a word naming an fnox config file or `~/.config/fnox`. */
function touchesConfigFile(command: Command): boolean {
  return (
    FILE_COMMANDS.has(base(command.argv[0])) &&
    command.argv.slice(1).some((word) => CONFIG_FILE.test(base(word)) || /(?:^|\/)\.config\/fnox(?:\/|$)/.test(word))
  )
}

/** The explicit `-c`/`--config` files that value-sourced `fnox set` commands in the list name. */
function explicitConfigTargets(commands: readonly Command[]): string[] {
  return commands.filter(setsWithValueSource).flatMap((command) => {
    const path = explicitConfig(command)
    return typeof path === "string" ? [path] : []
  })
}

/** Whether a written absolute path is the explicit config `target`, named absolute or relative to the call's directory. */
function sameFile(written: string, target: string): boolean {
  const clean = target.replace(/^\.\//, "")
  return written === clean || written.endsWith(`/${clean}`)
}

/** Whether `path` is an fnox config file: `fnox*.toml`, `.fnox*.toml`, or anything in `~/.config/fnox`. */
export function fnoxConfigPath(path: string, home: string = homedir()): boolean {
  return CONFIG_FILE.test(base(path)) || path === join(home, ".config", "fnox") || path.startsWith(join(home, ".config", "fnox") + "/")
}

/**
 * Whether a call passes a value to `fnox set` and also changes fnox configuration in the same command:
 * a file write to fnox config, a `fnox config` or `provider` change, or a write target the guard cannot
 * read. The provider type the guard checked may not be the one `fnox set` then uses.
 */
export function configWriteBesideSet(commands: readonly Command[], writes: readonly string[]): boolean {
  if (!commands.some(setsWithValueSource)) return false
  const explicit = explicitConfigTargets(commands)
  const names = (command: Command) => FILE_COMMANDS.has(base(command.argv[0])) && command.argv.slice(1).some((word) => explicit.some((target) => sameFile(word, target)))
  return (
    writes.some((path) => fnoxConfigPath(path) || explicit.some((target) => sameFile(path, target))) ||
    commands.some(touchesConfigFile) ||
    commands.some(names) ||
    commands.some(changesFnoxConfig)
  ) || commands.some(uncertainWrite)
}

/** Whether a command has redirects other than its here-documents (whose bodies the walk reads): a file or here-string. */
function opaqueRedirects(command: Command): boolean {
  return command.redirects.length > command.hereDocuments.length
}

const LAUNCHERS: ReadonlyMap<string, ReadonlySet<string> | true> = new Map<string, ReadonlySet<string> | true>([
  ["nix", new Set(["develop", "shell", "run"])],
  ["direnv", new Set(["exec"])],
  ["mise", new Set(["exec", "x"])],
  ["asdf", new Set(["exec"])],
  ["devbox", new Set(["run"])],
  ["uv", new Set(["run"])],
  ["poetry", new Set(["run"])],
  ["pnpm", new Set(["dlx"])],
  ["npx", true],
  ["bunx", true],
])
const SECRET_WRITE = /\bfnox\b[^|;&\n]*\b(?:set|s)\b|\bop\b[^|;&\n]*\bitem\s+(?:create|edit)\b/
const SECRET_WORDS = /\b(?:set|s)\b|\bitem\s+(?:create|edit)\b/

/**
 * Whether the call reaches `fnox set` or `op item create|edit` through an executor the walk cannot follow
 * with certainty: a shell fed by a pipe or redirect, `xargs`, `find -exec`, `parallel`, `env -S`, `eval`,
 * `source`, an alias or function, an expanded command name, or a launcher (`nix`, `mise`, `uv`, `npx`, …).
 */
export function indirectSecretWrite(commands: readonly Command[], inheritedStdin = false, outer = ""): boolean {
  const whole = [outer, ...new Set(commands.map((command) => command.source))].join("\n")
  const wholeHits = SECRET_WRITE.test(whole)
  return commands.some((command) => {
    if (command.argv.length === 0) return false
    const name = base(command.argv[0])
    const inner = command.argv.slice(1).join(" ")
    const innerHits = SECRET_WRITE.test(inner)
    if (/[$`]/.test(command.argv[0] as string)) return SECRET_WORDS.test(inner) || wholeHits
    if (SHELLS.has(name)) {
      const script = command.argv.findIndex((word, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
      if (script < 0)
        return wholeHits && (inheritedStdin || command.stage > 0 || opaqueRedirects(command))
      return wholeHits && expands(command, script + 1)
    }
    if (name === "xargs" || name === "parallel" || name === "eval") return innerHits
    if (name === "find") return command.argv.some((word) => ["-exec", "-execdir", "-ok", "-okdir"].includes(word)) && innerHits
    if (name === "source" || name === "." || name === "alias") return wholeHits
    if (command.wrappers.includes("env") && /\benv\s+(?:-\S+\s+)*(?:-[A-Za-z]*S|--split-string)/.test(command.source)) return SECRET_WRITE.test(command.argv.join(" ")) || wholeHits
    if (/\(\)\s*\{|\bfunction\s+[\w-]+/.test(command.source)) return wholeHits
    const launcher = LAUNCHERS.get(name)
    if (launcher === true) return innerHits
    if (launcher !== undefined) return launcher.has(command.argv[1] ?? "") && innerHits
    return false
  })
}

/** What `fnox` does with this command: dump values, or run an inner command that is refused. */
export function fnoxRefusal(
  command: Command,
  allow: readonly string[] = [],
  inherited: { literal: boolean; stdin?: boolean; piped?: boolean; documents: readonly HereDocument[]; depth: number; writesOf?: WritesOf } = {
    literal: false,
    documents: [],
    depth: 0,
  },
  types: ProviderTypes = () => undefined,
): Verdict | undefined {
  if (inherited.depth > MAX_NESTING) throw new NestingTooDeep()
  if (base(command.argv[0]) !== "fnox") return undefined
  const argv = command.argv
  let at = 1
  const config = explicitConfig(command)
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
  if (sub === "set" || sub === "s") return fnoxSetRefusal(command, at, inherited.literal || literalStdin(command), inherited.stdin === true, types, config)
  if (sub !== "exec") return undefined
  const start = execInner(args)
  if (start < 0) return undefined
  const first = at + 1 + start
  // Rebuild the child from its source words so an expansion stays an expansion.
  const inner = argv.slice(first)
  // The child inherits fnox's stdin and here-documents, through wrappers and nested fnox.
  const documents = [...inherited.documents, ...command.hereDocuments]
  const literal = inherited.literal || literalStdin(command)
  const stdin =
    inherited.stdin === true || command.stage > 0 || command.redirects.length > 0 || command.hereDocuments.length > 0
  // A pipe or redirect feeds text the walk cannot read; a here-document it does read.
  const piped = inherited.piped === true || command.stage > 0 || opaqueRedirects(command)
  const children = walkComplete(inner.map((word, i) => wordText(command, first + i) ?? quote(word)).join(" "))
  // A here-document fed to the shell left after the wrappers is that shell's script. The shell
  // reads all of stdin, so a parsed document is consumed: an inner level never gets it again.
  const scripts = children
    .filter((nested) => nested.context === "top" && SHELLS.has(base(nested.argv[0])))
    .filter((nested) => !nested.argv.some((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word)))
  const bodies = scripts.length === 0 ? [] : documents.flatMap((document) => walkComplete(document.body))
  const rest = scripts.length === 0 ? documents : []
  const writesOf = inherited.writesOf ?? (() => [])
  const policy = listPolicy(children, writesOf, piped, command.source) ??
    (bodies.length > 0 ? listPolicy(bodies, writesOf, piped, command.source) : undefined)
  if (policy !== undefined) return policy
  const check = (nested: Command, fed: boolean): Verdict | undefined => {
    if (dumpsEnvironment(nested)) return "dump"
    const op = opRefusal(nested, allow, fed)
    if (op !== undefined) return op
    return fnoxRefusal(nested, allow, { literal: fed, stdin, piped, documents: rest, depth: inherited.depth + 1, writesOf }, types)
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

/** Where each source's file writes land; the guard supplies it with the call's directory. */
export type WritesOf = (source: string) => readonly string[]

/**
 * The rules that look at a whole command list rather than one command: the executor rule and the
 * config-write rule. They run for the top-level commands and for every child a `fnox exec` runs,
 * so a nested command gets the same checks. `stdin` is true when the list's shells inherit stdin.
 */
export function listPolicy(
  commands: readonly Command[],
  writesOf: WritesOf,
  stdin = false,
  outer = "",
): "indirect" | "config" | undefined {
  if (indirectSecretWrite(commands, stdin, outer)) return "indirect"
  // Every source in the list: the top text and each script it runs, since a quoted script hides its writes.
  const writes = [...new Set(commands.map((command) => command.source))].flatMap((source) => writesOf(source))
  if (configWriteBesideSet(commands, writes)) return "config"
  return undefined
}

const MESSAGES: Record<Verdict, string> = {
  op: OP_MESSAGE,
  dump: FNOX_DUMP_MESSAGE,
  literal: LITERAL_MESSAGE,
  set: FNOX_SET_MESSAGE,
  store: FNOX_STORE_MESSAGE,
  indirect: FNOX_INDIRECT_MESSAGE,
  config: FNOX_CONFIG_MESSAGE,
}

/** The op-guard verdict for a call's commands, or `undefined`. Fails closed when its own analysis throws. */
export function opGuard(
  commands: readonly Command[],
  allow: readonly string[] = [],
  types: ProviderTypes = () => undefined,
  writesOf: WritesOf = () => [],
): string | undefined {
  try {
    const policy = listPolicy(commands, writesOf)
    if (policy !== undefined) return MESSAGES[policy]
    // Where fnox runs is unknown after a directory change, so no provider's config can be trusted.
    const known = changesDirectory(commands) ? () => undefined : types
    for (const command of commands) {
      const fed = literalFed(command, commands)
      const found = opRefusal(command, allow, fed) ?? fnoxRefusal(command, allow, { literal: fed, documents: [], depth: 0, writesOf }, known)
      if (found !== undefined) return MESSAGES[found]
    }
    return undefined
  } catch (error) {
    return error instanceof NestingTooDeep ? NESTING_MESSAGE : CHECK_FAILED_MESSAGE
  }
}
