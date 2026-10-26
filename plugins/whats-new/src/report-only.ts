/**
 * The report-only policy of the `whats-new` agent: which edits and shell commands
 * would change a project's dependencies. Ported from omp-plugins
 * (`whats-new/extensions/report-only-gate.ts`); the omp skill-read arming is gone,
 * because the policy now belongs to an agent instead of a session state.
 */

import { commandWords } from "@srobroek/opencode-lib/command-words"
import { tokenizeShell } from "@srobroek/opencode-lib/shell-tokenizer"

/** Dependency manifests. Lowercased basenames; macOS filesystems fold case. */
const MANIFESTS: Record<string, true> = {
  "package.json": true,
  "cargo.toml": true,
  "pyproject.toml": true,
  "go.mod": true,
  "go.sum": true,
  "requirements.txt": true,
  "composer.json": true,
  gemfile: true,
  pipfile: true,
  "package-lock.json": true,
  "npm-shrinkwrap.json": true,
  "pnpm-lock.yaml": true,
}

/** Any `*.lock` (uv, Cargo, poetry, yarn) plus bun's `bun.lock`/`bun.lockb`. */
const LOCKFILE = /\.lock$|^bun\.lock/

/** Separator tokens from `tokenizeShell`; `&&`/`||` arrive as two tokens each. */
const SEPARATORS: Record<string, true> = {
  ";": true,
  "&": true,
  "|": true,
  "\n": true,
  "(": true,
  ")": true,
  "$(": true,
}
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true }
/** Package runners that run the package binary named after their own options (`npx ncu -u`). */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx"])
/** Package-runner options that take the next word (`npx -p npm-check-updates ncu -u`). */
const PACKAGE_RUNNER_VALUE_FLAGS: ReadonlySet<string> = new Set(["-p", "--package"])
/** Package-manager options that take a value before the subcommand (`npm --prefix /repo install`). */
const PM_VALUE_FLAGS: Record<string, true> = {
  "--prefix": true,
  "-C": true,
  "--dir": true,
  "--cwd": true,
  "--filter": true,
  "-F": true,
  "-w": true,
  "--workspace": true,
  "--registry": true,
  "--cache": true,
  "--userconfig": true,
  "--directory": true,
  "--project": true,
  "--config-file": true,
  "--cache-dir": true,
}
// Maps and Sets, not object literals: a word such as `constructor` or `toString` must
// not resolve to an inherited member and read as a package manager or a subcommand.
const NPM_INSTALL: ReadonlySet<string> = new Set([
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "install",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "it",
  "install-test",
  "cit",
  "install-ci-test",
  "update",
  "up",
  "upgrade",
  "udpate",
])
/** Subcommands that install, add, or move a version, per package manager. */
const MUTATING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["npm", NPM_INSTALL],
  ["pnpm", new Set(["i", "install", "add", "update", "up", "upgrade", "it", "install-test"])],
  ["bun", new Set(["i", "install", "add", "update", "up", "upgrade"])],
  ["yarn", new Set(["install", "add", "up", "upgrade", "upgrade-interactive", "update"])],
  ["pip", new Set(["install"])],
  ["uv", new Set(["add", "sync"])],
  ["poetry", new Set(["add", "update", "install"])],
  ["cargo", new Set(["add", "install", "update"])],
  ["go", new Set(["get"])],
  ["bundle", new Set(["install", "update", "add"])],
  ["bundler", new Set(["install", "update", "add"])],
  ["gem", new Set(["install", "update"])],
  ["composer", new Set(["require", "update", "upgrade", "install"])],
])
/** Subcommands that run another command (`pnpm dlx ncu -u`). */
const RUNNERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["npm", new Set(["exec", "x"])],
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx", "exec"])],
  ["bun", new Set(["x"])],
])
/** Nested `bash -c` / substitution depth past which the gate stops reading and blocks. */
const MAX_DEPTH = 8

function subcommand(args: string[]): [string | undefined, number] {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith("-")) return [arg, i]
    if (Object.hasOwn(PM_VALUE_FLAGS, arg)) i++
  }
  return [undefined, args.length]
}

/** The command a package runner runs: the words after its own options. */
function packageRunnerCommand(args: string[]): string[] {
  let i = 0
  while (args[i]?.startsWith("-")) i += PACKAGE_RUNNER_VALUE_FLAGS.has(args[i] as string) ? 2 : 1
  return args.slice(i)
}

/** Whether one simple command (its words, separators removed) installs or moves a dependency. */
function simpleCommandMutates(words: string[], depth: number): boolean {
  if (depth > MAX_DEPTH) return true
  const [first, ...rest] = commandWords(words).argv
  if (first === undefined) return false
  const name = first.slice(first.lastIndexOf("/") + 1).toLowerCase()
  if (PACKAGE_RUNNERS.has(name)) return simpleCommandMutates(packageRunnerCommand(rest), depth + 1)
  if (Object.hasOwn(SHELLS, name)) {
    const flag = rest.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    const script = flag === -1 ? undefined : rest[flag + 1]
    return script !== undefined && commandMutates(script, depth + 1)
  }
  // `--help` prints usage and changes nothing (`uv add --help`).
  if (rest.some((arg) => arg === "--help" || arg === "-h")) return false
  if (name === "ncu" || name === "npm-check-updates") return rest.some((arg) => arg === "-u" || arg === "--upgrade")
  if (/^python\d*(?:\.\d+)*$/.test(name)) {
    const module = rest.indexOf("-m")
    return module !== -1 && rest[module + 1] === "pip" && subcommand(rest.slice(module + 2))[0] === "install"
  }
  const pm = /^pip\d*(?:\.\d+)*$/.test(name) ? "pip" : name
  const table = MUTATING.get(pm)
  if (table === undefined) return false
  const [sub, at] = subcommand(rest)
  const after = rest.slice(at + 1)
  // Bare `yarn` installs.
  if (sub === undefined) return pm === "yarn" && !rest.some((arg) => arg === "--version" || arg === "-v")
  if (RUNNERS.get(pm)?.has(sub)) return simpleCommandMutates(after, depth + 1)
  if (pm === "uv" && sub === "pip") {
    const [inner] = subcommand(after)
    return inner === "install" || inner === "sync"
  }
  if (pm === "uv" && sub === "lock") {
    return after.some(
      (arg) => arg === "-U" || arg === "--upgrade" || arg === "-P" || arg.startsWith("--upgrade-package"),
    )
  }
  return table.has(sub)
}

/**
 * Whether a bash command installs, adds, or moves a dependency. Words are read
 * quote-aware at command position only, so `echo "npm install"` is data while
 * `cd repo && npm i` is a command. Here-document bodies count only for their
 * substitutions. Backtick and `$( … )` substitutions are read wherever they appear,
 * including inside quotes (a single-quoted one is over-matched: the gate blocks).
 */
export function commandMutates(command: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true
  let words: string[] = []
  for (const token of tokenizeShell(command, { hereDocumentSubstitutionsOnly: true })) {
    if (token.sawQuote || !Object.hasOwn(SEPARATORS, token.value)) {
      words.push(token.value)
      continue
    }
    if (simpleCommandMutates(words, depth)) return true
    words = []
  }
  if (simpleCommandMutates(words, depth)) return true
  for (const match of command.matchAll(/`([^`]*)`|\$\(([^()]*)\)/g)) {
    if (commandMutates(match[1] ?? match[2] ?? "", depth + 1)) return true
  }
  return false
}

export const AGENT_ID = "whats-new"
export const APPLY_ACTION = "dep_apply"

export const DENY_REASON =
  "blocked by whats-new (report-only): this agent reports what changed between two versions and changes " +
  "nothing itself. Do not edit dependency manifests or lockfiles and do not run installers or upgrade " +
  "commands while researching; the finding belongs in the report. If the user wants the upgrade applied, " +
  "that is dep-update's job, run from another agent with its dep_scan/dep_apply loop."

export function isDependencyFile(raw: string): boolean {
  const path = raw.replaceAll("\\", "/").trim()
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  return Object.hasOwn(MANIFESTS, name) || LOCKFILE.test(name)
}

export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/** Manifest basenames as projects spell them, for path rules (which match case-sensitively). */
const MANIFEST_NAMES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "go.sum",
  "Gemfile",
  "composer.json",
]

/** Package-manager spellings that run the same tool (`pip3 install`, `python -m pip install`). */
const PIP_ALIASES = ["pip", "pip3", "python -m pip", "python3 -m pip"]

/**
 * The agent's static permission rules: deny edits to manifests and lockfiles at any
 * depth, deny the installer and upgrade commands of every package manager the gate
 * knows when written plainly, and deny `dep_apply`. Wrapped and nested forms
 * (`sudo npm i`, `bash -c "uv sync"`) are caught by `decideEvaluation`.
 */
export function reportOnlyPermissions(): PermissionRule[] {
  const rules: PermissionRule[] = []
  const deny = (action: string, resource: string) => rules.push({ action, resource, effect: "deny" })
  for (const name of MANIFEST_NAMES) {
    deny("edit", name)
    deny("edit", `*/${name}`)
  }
  deny("edit", "*.lock")
  for (const [pm, subcommands] of MUTATING) {
    for (const pmName of pm === "pip" ? PIP_ALIASES : [pm]) {
      for (const sub of subcommands) deny("shell", `${pmName} ${sub} *`)
    }
  }
  deny("shell", "yarn")
  deny("shell", "uv pip install *")
  deny("shell", "uv pip sync *")
  deny("shell", "ncu -u *")
  deny(APPLY_ACTION, "*")
  return rules
}

/** The evaluation fields the agent's gate reads and writes. */
export type Evaluation = {
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: "allow" | "deny" | "ask"
  message?: string
}

/**
 * Deny, for the whats-new agent only, what its static rules cannot spell: an
 * installer behind a wrapper or inside a substitution, and a manifest edit in any case.
 */
export function decideEvaluation(evaluation: Evaluation): void {
  if (evaluation.agent !== AGENT_ID || evaluation.effect === "deny") return
  const blocked =
    evaluation.action === APPLY_ACTION ||
    (evaluation.action === "shell" && evaluation.resources.some((command) => commandMutates(command))) ||
    (evaluation.action === "edit" && evaluation.resources.some(isDependencyFile))
  if (!blocked) return
  evaluation.effect = "deny"
  evaluation.message = DENY_REASON
}
