import { interpreterCommandString, readsScriptFromStdin, scanShell, stdinSource } from "./shell.ts"

const ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"] as const
type ActorVar = (typeof ACTOR_VARS)[number]

/**
 * Global flags of `bd` itself that consume the next word, read from `bd --help`
 * on 1.3.0. A missing entry is not cosmetic: the parser would take the flag's
 * VALUE for the verb, so `bd --database x close y` would look like verb `x`.
 */
const VALUE_FLAGS = new Set([
  "--actor",
  "--database",
  "--db",
  "-C",
  "--directory",
  "--dolt-auto-commit",
  "--mem-profile",
])

/**
 * Prefixes that keep the following command in command position. They are
 * intentionally limited to shell control words whose condition/body starts
 * with the command immediately after the word; other shell syntax remains
 * fail-closed because it is not a simple invocation.
 */
const CONTROL_PREFIXES: Record<string, true> = {
  "!": true,
  if: true,
  elif: true,
  else: true,
  while: true,
  until: true,
  do: true,
}

const TRANSPARENT_WRAPPERS: Record<string, true> = { command: true, env: true, sudo: true, time: true }

const WRAPPER_VALUE_FLAGS: Record<string, true> = {
  "-C": true,
  "--chdir": true,
  "--chroot": true,
  "--command-timeout": true,
  "-g": true,
  "--group": true,
  "-h": true,
  "--host": true,
  "-p": true,
  "--prompt": true,
  "-R": true,
  "-T": true,
  "-u": true,
  "--unset": true,
  "--user": true,
}

export interface BdInvocation {
  verb: string
  args: string[]
  /** Global flags and their values, sitting between the `bd` word and the verb. */
  globals: string[]
  /** `NAME=value` assignments prefixed to this very `bd` word. */
  prefix: string[]
  /** Actor values an earlier `export NAME=value` set, read in order (an `unset` drops it). */
  exported: Partial<Record<ActorVar, string>>
  /** Actor values exported where they may not run (an `if` body, after `&&`/`||`); never counted as naming an actor. */
  conditional: string[]
  /** Actor variables removed by an `env -u`/`env -i` wrapper. */
  unset: Partial<Record<ActorVar, true>>
}

type ActorState = Partial<Record<ActorVar, string>>

const OPENERS = new Set(["if", "while", "until", "for", "select", "case"])
const HEADER_ONLY = new Set(["for", "select", "case"])
const CLOSERS = new Set(["fi", "done", "esac"])
const BRANCHES = new Set(["else", "elif"])
const ASSIGNMENT = /^[A-Za-z_]\w*=/

const basename = (word: string): string => word.split("/").pop() ?? word

/** Apply a command-position `export NAME=value` or `unset NAME` to the running actor state. */
function applyActorBuiltin(state: ActorState, values: string[], conditional: string[] | undefined): void {
  const name = values[0]
  if (name !== "export" && name !== "unset") return
  for (const arg of values.slice(1)) {
    const variable = ACTOR_VARS.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`))
    if (variable === undefined) continue
    // Where the command may not run, an export is only a possibility; an unset changes nothing we rely on.
    if (conditional !== undefined) {
      if (name === "export" && arg.includes("=")) conditional.push(arg.slice(variable.length + 1))
    } else if (name === "unset") delete state[variable]
    else if (arg.includes("=")) state[variable] = arg.slice(variable.length + 1)
  }
}

/**
 * Every `bd` invocation in the command line, with the environment it runs under.
 *
 * Read from the shared structural scanner, never from the command text: a quoted
 * word is data, so `echo ";" export BEADS_ACTOR=x` exports nothing and `bd comments
 * add x "bd create y"` creates nothing. Executable substitutions and shell-fed
 * here-documents are read too. An `export BEADS_ACTOR=x` counts for the commands after it;
 * a bare `BEADS_ACTOR=x; bd close y` never does, since without `export` it does not reach `bd`.
 */
export function bdInvocations(command: string, inherited: ActorState = {}): BdInvocation[] {
  return readCommand(command, inherited).invocations
}

/** The actor exports in force once `command` has run, for the commands nested inside it. */
export function actorStateAfter(command: string, inherited: ActorState = {}): ActorState {
  return readCommand(command, inherited).state
}

function readCommand(command: string, inherited: ActorState): { invocations: BdInvocation[]; state: ActorState } {
  const out: BdInvocation[] = []
  const scan = scanShell(command, { executableSubstitutionsOnly: true })
  let state: ActorState = { ...inherited }
  // A subshell `( … )` gets a copy of the actor state; its exports end with it.
  const scopes: ActorState[] = []
  // Compound-command depth and whether this list continued after `&&` / `||`: exports there are conditional.
  let compounds = 0
  let andChained = false
  let orChained = false
  // Exports made inside an `&&` chain hold for the rest of that chain only.
  let chainExports: Array<{ variable: ActorVar; value: string }> = []
  const maybe: string[] = []
  // Substitutions not claimed by a command's own words (here-document bodies) run with the final state.
  const unclaimed = [...scan.substitutions]

  for (const item of scan.items) {
    if (item.kind === "operator") {
      if (item.operator === "(") {
        scopes.push(state)
        state = { ...state }
      } else if (item.operator === ")" && scopes.length > 0) state = scopes.pop() as ActorState
      else if (item.operator === "&&") andChained = true
      else if (item.operator === "||") orChained = true
      else if (item.operator === ";" || item.operator === "\n" || item.operator === "&") {
        for (const { variable, value } of chainExports) {
          if (state[variable] === value) delete state[variable]
          maybe.push(value)
        }
        chainExports = []
        andChained = false
        orChained = false
      }
      continue
    }

    // A substitution runs where its command does, with the exports in force at that point.
    // An unquoted here-document body expands in the shell that owns the command.
    const spans = [...item.words, ...item.redirects]
    const texts: string[] = []
    if (spans.length > 0) {
      texts.push(command.slice(Math.min(...spans.map((w) => w.start)), Math.max(...spans.map((w) => w.end))))
    }
    for (const document of item.hereDocuments) {
      if (!document.quoted) texts.push(`:<<__HEREDOC_END__\n${document.body}__HEREDOC_END__\n`)
    }
    for (const text of texts) {
      for (const source of scanShell(text, { executableSubstitutionsOnly: true }).substitutions) {
        const at = unclaimed.indexOf(source)
        if (at >= 0) unclaimed.splice(at, 1)
        out.push(...bdInvocations(source, state))
      }
    }

    const words = item.words
    let k = 0
    let skip = false
    while (k < words.length && words[k]?.quoted === false) {
      const value = words[k]?.value as string
      if (OPENERS.has(value)) {
        compounds++
        skip = HEADER_ONLY.has(value)
      } else if (CLOSERS.has(value)) {
        compounds = Math.max(0, compounds - 1)
        skip = true
      }
      else if (!BRANCHES.has(value) && value !== "!" && value !== "then" && value !== "do") break
      k++
      if (skip) break
    }
    if (skip) continue

    let a = k
    while (a < words.length && ASSIGNMENT.test(command.slice(words[a]?.start, words[a]?.end))) a++
    const assigned = words.slice(k, a).map((word) => word.value)
    const values = words.slice(a).map((word) => word.value)
    if (values.length === 0) continue
    const before = { ...state }
    applyActorBuiltin(state, values, compounds > 0 || orChained ? maybe : undefined)
    if (andChained)
      for (const variable of ACTOR_VARS) {
        const value = state[variable]
        if (value !== undefined && value !== before[variable]) chainExports.push({ variable, value })
      }
    const found = resolveBd(values, assigned)
    if (found !== undefined) {
      const scanned = scanGlobals(values, found.next)
      const verb = values[scanned.next]
      if (verb !== undefined) {
        out.push({
          verb: verb.toLowerCase(),
          args: values.slice(scanned.next + 1),
          globals: scanned.globals,
          prefix: found.prefix,
          exported: { ...state },
          conditional: [...maybe],
          unset: found.unset,
        })
      }
    }
    // The interpreter's own `BD_ACTOR=A bash -c '…'` prefix is exported to the script it runs.
    const scriptState: ActorState = { ...state }
    for (const assignment of assigned) {
      const variable = ACTOR_VARS.find((candidate) => assignment.startsWith(`${candidate}=`))
      if (variable !== undefined) scriptState[variable] = assignment.slice(variable.length + 1)
    }
    const inline = interpreterCommandString(values)
    if (inline !== undefined) out.push(...bdInvocations(inline, scriptState))
    if (readsScriptFromStdin(values)) {
      const script = stdinSource(item)
      if (script !== undefined) out.push(...bdInvocations(script, scriptState))
    }
  }
  for (const source of unclaimed) out.push(...bdInvocations(source, state))
  return { invocations: out, state }
}

/** The `bd` word after shell assignments and transparent wrappers, with what those wrappers set. */
function resolveBd(
  values: string[],
  assigned: string[],
): { next: number; prefix: string[]; unset: Partial<Record<ActorVar, true>> } | undefined {
  let i = 0
  const prefix = [...assigned]
  const unset: Partial<Record<ActorVar, true>> = {}
  while (true) {
    const word = basename(values[i] ?? "")
    if (CONTROL_PREFIXES[word] === true) {
      i++
      continue
    }
    if (TRANSPARENT_WRAPPERS[word] !== true) break
    i++
    if (word === "command") {
      // `command -v bd` only describes `bd`; `command -- bd` and `command -p bd` run it.
      let describes = false
      while (values[i]?.startsWith("-") === true) {
        const flag = values[i] as string
        i++
        if (flag === "--") break
        if (/^-[A-Za-z]*[vV]/.test(flag)) describes = true
      }
      if (describes) return undefined
      continue
    }
    while (true) {
      while (ASSIGNMENT.test(values[i] ?? "")) {
        const assignment = values[i] as string
        prefix.push(assignment)
        const variable = assignment.slice(0, assignment.indexOf("="))
        if (variable === "BEADS_ACTOR" || variable === "BD_ACTOR") delete unset[variable]
        i++
      }
      const flag = values[i]
      if (flag === undefined || !flag.startsWith("-")) break
      if (word === "env") {
        if (flag === "--") {
          i++
          break
        }
        if (flag === "-i" || flag === "--ignore-environment") {
          unset.BEADS_ACTOR = true
          unset.BD_ACTOR = true
          i++
          continue
        }
        const unsetName =
          flag === "-u" || flag === "--unset"
            ? values[i + 1]
            : flag.startsWith("--unset=")
              ? flag.slice("--unset=".length)
              : flag.startsWith("-u") && flag.length > 2
                ? flag.slice(2)
                : undefined
        if (unsetName === "BEADS_ACTOR" || unsetName === "BD_ACTOR") unset[unsetName] = true
        if (flag === "-u" || flag === "--unset") i += 2
        else i++
        continue
      }
      i++
      if (WRAPPER_VALUE_FLAGS[flag] === true) i++
    }
  }
  const word = values[i]
  if (word === undefined || basename(word) !== "bd") return undefined
  return { next: i + 1, prefix, unset }
}

/**
 * The global flags between `bd` and its verb, and where the verb starts.
 *
 * `--flag=value` is one word and consumes nothing after it. Reading it as a bare
 * flag would take the NEXT word for the value and leave the verb one place off,
 * which is how `--directory=/path` came to resolve the wrong store.
 */
function scanGlobals(tokens: string[], from: number): { globals: string[]; next: number } {
  const globals: string[] = []
  let i = from
  while (true) {
    const flag = tokens[i]
    if (flag === undefined || !flag.startsWith("-")) break
    globals.push(flag)
    i++
    if (flag.includes("=")) continue
    if (!VALUE_FLAGS.has(flag)) continue
    const value = tokens[i]
    if (value !== undefined) globals.push(value)
    i++
  }
  return { globals, next: i }
}

/** The value a global flag carries, in either the `--flag value` or `--flag=value` spelling. */
export function globalValue(globals: string[], names: string[]): string | undefined {
  for (const [index, token] of globals.entries()) {
    for (const name of names) {
      if (token === name) return globals[index + 1]
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1)
    }
  }
  return undefined
}

/**
 * Whether a boolean flag is switched ON, in any spelling the CLI accepts.
 *
 * `--flag` and `--flag=true` are on; `--flag=false` is OFF and treating it as
 * present inverted the meaning of `--readonly=false` and `--help=false`. A value
 * bd itself would reject counts as off, because such a command fails and writes
 * nothing.
 */
export function flagEnabled(tokens: string[], names: string[]): boolean {
  for (const token of tokens) {
    for (const name of names) {
      if (token === name) return true
      if (token.startsWith(`${name}=`)) return TRUTHY[token.slice(name.length + 1)] === true
      // `bd orphans -fj` is `-f -j`, so a fused run of short booleans has to be
      // read letter by letter; matching the whole token missed `-f` entirely.
      if (name.length === 2 && name.startsWith("-") && /^-[A-Za-z]{2,}$/.test(token) && token.includes(name.slice(1))) {
        return true
      }
    }
  }
  return false
}

/** The values Go's flag parsing reads as true. */
const TRUTHY: Record<string, true> = { "": true, "1": true, t: true, T: true, TRUE: true, true: true, True: true }

/** Hunt trigger verbs for `bd_mutate_actor_claim`. */
export const MUTATING_VERBS: Record<string, true> = {
  assign: true,
  batch: true,
  claim: true,
  close: true,
  done: true,
  comment: true,
  cook: true,
  create: true,
  "create-form": true,
  defer: true,
  delete: true,
  duplicate: true,
  edit: true,
  forget: true,
  import: true,
  link: true,
  new: true,
  note: true,
  priority: true,
  promote: true,
  q: true,
  remember: true,
  rename: true,
  reopen: true,
  "set-state": true,
  ship: true,
  supersede: true,
  tag: true,
  undefer: true,
  update: true,
}

const GROUP_WRITES: Record<string, Record<string, true>> = {
  audit: { label: true, record: true },
  comments: { add: true },
  dep: { add: true, relate: true, remove: true, unrelate: true },
  epic: { "close-eligible": true },
  gate: { "add-waiter": true, check: true, create: true, resolve: true },
  kv: { append: true, delete: true, rm: true, set: true, update: true },
  label: { add: true, propagate: true, remove: true },
  "merge-slot": { acquire: true, create: true, release: true },
  swarm: { create: true },
  todo: { add: true, done: true },
}

const MOL_WRITES: Record<string, true> = {
  bond: true,
  burn: true,
  distill: true,
  pour: true,
  squash: true,
}

export { commandFromInput as extractCommand } from "./shell.ts"

/** The environment a bash tool call supplies to its child process. */
export function environmentForInput(
  input: unknown,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const supplied =
    input !== null && typeof input === "object" ? (input as { env?: unknown }).env : undefined
  if (supplied !== null && typeof supplied === "object") {
    for (const [name, value] of Object.entries(supplied)) {
      if (typeof value === "string") env[name] = value
    }
  }
  return env
}

export { agentActor } from "./host.ts"

/**
 * The ONE actor this invocation will really write under.
 *
 * Measured against bd 1.3.0: an explicit `--actor` flag wins, followed by
 * BEADS_ACTOR (command-local assignment, exported assignment, then ambient
 * environment), and finally BD_ACTOR with the same source precedence.
 */
export function invocationActor(invocation: BdInvocation, env: NodeJS.ProcessEnv): string | null {
  const literal = (value: string | undefined): string | null => {
    if (!value?.trim() || /[$`\\\0]/.test(value)) return null
    return value.trim()
  }
  const actorFlag = globalValue(invocation.globals, ["--actor"])
  const explicit = literal(actorFlag)
  if (explicit !== null) return explicit
  const resolve = (variable: ActorVar): string | null => {
    if (invocation.unset[variable] === true) return null
    const assignment = invocation.prefix.findLast((token) => token.startsWith(`${variable}=`))
    const value =
      assignment !== undefined
        ? assignment.slice(variable.length + 1)
        : (invocation.exported[variable] ?? env[variable])
    return literal(value)
  }
  return resolve("BEADS_ACTOR") ?? resolve("BD_ACTOR")
}

/**
 * Every actor a command line writes under: one per mutating invocation, deduped.
 *
 * Still plural, because one command line can carry several invocations under
 * different actors. What it no longer does is report two actors for a single write
 * because two variables were set.
 */
export function actorValues(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const actors = bdInvocations(command)
    .filter(isMutatingInvocation)
    .map((invocation) => invocationActor(invocation, env))
    .filter((actor): actor is string => actor !== null)
  return [...new Set(actors)]
}

export function actorPresent(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const first = bdInvocations(command)[0]
  return first !== undefined && invocationActor(first, env) !== null
}

/**
 * One `bd` invocation read from an argv the plugin itself builds, so an internal
 * spawn is classified by the same rules as a command line an agent typed.
 * `undefined` when the argv carries no verb.
 */
export function invocationFromArgv(args: string[]): BdInvocation | undefined {
  const scanned = scanGlobals(args, 0)
  const verb = args[scanned.next]
  if (verb === undefined) return undefined
  return {
    verb: verb.toLowerCase(),
    args: args.slice(scanned.next + 1),
    globals: scanned.globals,
    prefix: [],
    exported: {},
    conditional: [],
    unset: {},
  }
}

/** First literal `bd` invocation, after global flags. */
export function firstBdVerb(command: string): string | null {
  return bdInvocations(command)[0]?.verb ?? null
}

export function isMutatingInvocation({ verb, args }: BdInvocation): boolean {
  if (args.includes("--help") || args.includes("-h")) return false
  if (verb === "duplicates") return args.includes("--auto-merge") && !args.includes("--dry-run")
  if (MUTATING_VERBS[verb] === true) return true
  if (verb === "ready") return flagEnabled(args, ["--claim"])
  if (verb === "dep" && args.includes("--blocks")) return true
  if (verb === "mol") {
    if (args.includes("--dry-run")) return false
    const action = args[0] ?? ""
    if (MOL_WRITES[action] === true) return true
    if (action !== "wisp") return false
    const wispAction = args[1]
    return wispAction === "create" || wispAction === "gc" || (wispAction !== undefined && wispAction !== "list")
  }
  const action = args[0] ?? ""
  return GROUP_WRITES[verb]?.[action] === true
}

export function isMutatingBdCommand(command: string): boolean {
  return bdInvocations(command).some(isMutatingInvocation)
}

/** `bd update <id> --claim` or `bd claim <id>`, at shell command position. */
export function isClaimCommand(command: string): boolean {
  return bdInvocations(command).some(
    ({ verb, args }) => verb === "claim" || ((verb === "update" || verb === "ready") && flagEnabled(args, ["--claim"])),
  )
}

export type ActorGateDecision =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "advisory"; text: string }

const CLAIM_REASON =
  "bd claim / `bd update <id> --claim` without BEADS_ACTOR or BD_ACTOR creates undistinguishable dead claims. Subagent sessions get BD_ACTOR from the plugin at the start of every command, so an actor is missing only when this command clears or blanks it or the session is a main session; remove the `unset`/empty assignment or set a literal <harness>/<agent-name>/<session-id>, then retry."

/**
 * Verbs that construct a new issue. Without an actor, `created_by` records the
 * invoking human's git identity; Owner is always the git identity and never
 * identifies the agent. All three verbs must refuse rather than warn so the
 * new issue is attributable before it is created.
 */
const CREATING_VERBS: Record<string, true> = {
  create: true,
  "create-form": true,
  new: true,
}

const CREATE_REASON =
  "bd create / `bd new` / `bd create-form` without BEADS_ACTOR or BD_ACTOR records the invoking human's git identity in created_by. Owner is always the git identity and never identifies the agent. Subagent sessions get BD_ACTOR from the plugin at the start of every command, so an actor is missing only when this command clears or blanks it or the session is a main session; remove the `unset`/empty assignment or set a literal <harness>/<agent-name>/<session-id>, then retry."

const ADVISORY_TEXT =
  "BEADS_ACTOR and BD_ACTOR are unset on this mutating `bd` command. Without an actor, created_by records the invoking human's git identity; Owner is always the git identity and never identifies the agent. Subagent sessions get BD_ACTOR from the plugin at the start of every command, so an actor is missing only when this command clears or blanks it or the session is a main session; remove the `unset`/empty assignment or set a literal <harness>/<agent-name>/<session-id>, then retry."

/** Decide across command-position segments and recursively executable children. */
export function decideActorParsed(
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env,
  inherited: ActorState = {},
): ActorGateDecision {
  if (parsed === null || typeof parsed !== "object") return { kind: "block", reason: "command could not be parsed" }
  const candidate = parsed as { command?: unknown; nested?: unknown }
  if (typeof candidate.command !== "string" || !Array.isArray(candidate.nested)) {
    return { kind: "block", reason: "command could not be parsed" }
  }
  // Decide on the original command text. Re-joining argv with spaces drops quoting, so a
  // quoted "; bd create" would become a command and prefix assignments would vanish.
  let advisory = false
  const own = decideActorGate(candidate.command, env, inherited)
  if (own.kind === "block") return own
  if (own.kind === "advisory") advisory = true
  const after = actorStateAfter(candidate.command, inherited)
  for (const child of candidate.nested) {
    const decision = decideActorParsed(child, env, after)
    if (decision.kind === "block") return decision
    if (decision.kind === "advisory") advisory = true
  }
  return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" }
}

/**
 * Scope: this gate is an attribution aid. The plugin injects an actor into every session's
 * `bd` calls, so its verdict is advisory (see shell-gates), and it cannot stop an agent that
 * sets a wrong actor on purpose. The other gates that read commands through the shared parser
 * (close, update-close, unclaim, the embedded-write lock, the wait guard) are real controls;
 * parser bugs that let a command slip past them are bugs to fix.
 */
export function decideActorGate(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  inherited: ActorState = {},
): ActorGateDecision {
  let advisory = false
  for (const invocation of bdInvocations(command, inherited)) {
    if (!isMutatingInvocation(invocation) || invocationActor(invocation, env) !== null) {
      continue
    }
    const { verb, args } = invocation
    const claim = verb === "claim" || ((verb === "update" || verb === "ready") && flagEnabled(args, ["--claim"]))
    if (claim) return { kind: "block", reason: CLAIM_REASON }
    if (CREATING_VERBS[verb] === true) return { kind: "block", reason: CREATE_REASON }
    advisory = true
  }
  return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" }
}
