import { scanShell } from "./shell.ts"

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
  /**
   * Actor values the shell has exported to this `bd`. An empty string means the
   * variable was unset, unexported or emptied, or that it might have been: a
   * state the scanner cannot prove counts as no actor.
   */
  exported: Partial<Record<ActorVar, string>>
  /** Actor variables removed by an `env -u`/`env -i` wrapper. */
  unset: Partial<Record<ActorVar, true>>
}

type ActorState = Partial<Record<ActorVar, string>>

/** Builtins that read or write the exported environment of the current shell. */
const STATE_BUILTINS = new Set([
  "export",
  "unset",
  "eval",
  "source",
  ".",
  "declare",
  "typeset",
  "local",
  "read",
  "readonly",
])
/** Interpreters that execute a here-document body as commands. */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "source", "."])
const OPENERS = new Set(["if", "while", "until", "for", "select", "case"])
const HEADER_ONLY = new Set(["for", "select", "case"])
const CLOSERS = new Set(["fi", "done", "esac"])
const BRANCHES = new Set(["else", "elif"])
const ASSIGNMENT = /^[A-Za-z_]\w*=/

/** What survives when either of two states may be the real one. Unprovable means no actor. */
function mergeStates(a: ActorState, b: ActorState): ActorState {
  const out: ActorState = {}
  for (const variable of ACTOR_VARS) {
    const x = a[variable]
    const y = b[variable]
    if (x === "" || y === "") out[variable] = ""
    else if (x === undefined || y === undefined) continue
    else out[variable] = x
  }
  return out
}

const isPipe = (item: { kind: string; operator?: string } | undefined): boolean =>
  item?.kind === "operator" && (item.operator === "|" || item.operator === "|&")

const basename = (word: string): string => word.split("/").pop() ?? word

type Frame = {
  kind: "root" | "group" | "compound"
  /** The state when the group opened; a subshell or a branch that did not run leaves this behind. */
  base: ActorState
  /** The state at the start of the current and-or list, restored when the list is backgrounded. */
  listStart: ActorState
  /** The state before the first `&&` / `||` of the current list: what holds if the rest never runs. */
  cond?: ActorState
  /** The merged end state of the branches of a compound command closed so far. */
  branches?: ActorState
}

/**
 * Every `bd` invocation in the command line, with the environment it runs under.
 *
 * Read from the shared structural scanner, never from the command text: a quoted
 * word is data, so `echo ";" export BEADS_ACTOR=x` exports nothing and `bd comments
 * add x "bd create y"` creates nothing. Exports follow the shell's own scoping:
 * `export BEADS_ACTOR=x && bd close y` counts, while an export inside `( )`, `{ }`,
 * a pipeline, a background job or a branch that may not run does not, and an
 * `unset`, an emptying assignment or an `eval` removes the actor. A bare
 * `BEADS_ACTOR=x; bd close y` never counts: without `export` it does not reach `bd`.
 */
export function bdInvocations(command: string): BdInvocation[] {
  const out: BdInvocation[] = []
  const { items } = scanShell(command)
  let state: ActorState = {}
  let pipeBase: ActorState = {}
  const stack: Frame[] = [{ kind: "root", base: state, listStart: state }]
  const top = (): Frame => stack[stack.length - 1] as Frame
  const endList = (): void => {
    const frame = top()
    if (frame.cond !== undefined) state = mergeStates(frame.cond, state)
    frame.cond = undefined
    frame.listStart = state
  }
  const open = (kind: "group" | "compound"): void => {
    stack.push({ kind, base: state, listStart: state })
  }
  const branch = (): void => {
    const frame = top()
    if (frame.kind !== "compound") return
    endList()
    frame.branches = frame.branches === undefined ? state : mergeStates(frame.branches, state)
    state = frame.base
    frame.listStart = state
  }
  const close = (kind: "group" | "compound"): void => {
    if (top().kind !== kind) return
    endList()
    const frame = stack.pop() as Frame
    state = kind === "group" ? frame.base : mergeStates(frame.base, mergeStates(frame.branches ?? state, state))
  }

  for (const [index, item] of items.entries()) {
    if (item.kind === "operator") {
      switch (item.operator) {
        case "|":
        case "|&":
          state = pipeBase
          break
        case "&&":
        case "||":
          top().cond ??= state
          break
        case "&":
          state = top().listStart
          top().cond = undefined
          break
        case ";":
        case "\n":
          endList()
          break
        case ";;":
          branch()
          break
        case "(":
        case "{":
          open("group")
          break
        case ")":
        case "}":
          close("group")
          break
      }
      if (item.operator !== "|" && item.operator !== "|&") pipeBase = state
      continue
    }

    const words = item.words
    let k = 0
    let skip = false
    while (k < words.length && words[k]?.quoted === false) {
      const value = words[k]?.value as string
      if (OPENERS.has(value)) {
        open("compound")
        skip = HEADER_ONLY.has(value)
      } else if (BRANCHES.has(value)) branch()
      else if (CLOSERS.has(value)) {
        close("compound")
        skip = true
      } else if (value !== "!" && value !== "then" && value !== "do") break
      k++
      if (skip) break
    }
    if (skip) continue

    let a = k
    while (a < words.length && ASSIGNMENT.test(command.slice(words[a]?.start, words[a]?.end))) a++
    const assigned = words.slice(k, a).map((word) => word.value)
    const values = words.slice(a).map((word) => word.value)
    if (values.length === 0) {
      for (const assignment of assigned) state = assignBare(state, assignment)
    } else if (stateBuiltin(values) !== undefined) {
      state = applyBuiltin(state, values)
    } else {
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
            unset: found.unset,
          })
        }
      }
      if (SHELL_INTERPRETERS.has(basename(values[0] ?? ""))) {
        for (const document of item.hereDocuments) out.push(...bdInvocations(document.body))
      }
    }
    if (isPipe(items[index - 1]) && !isPipe(items[index + 1])) state = pipeBase
  }
  return out
}

/** `export`, `unset` and the like at command position, looking through `builtin` and `command`. */
function stateBuiltin(values: string[]): { name: string; args: string[] } | undefined {
  let at = 0
  if (values[0] === "builtin" || values[0] === "command") at = values[1] === "--" ? 2 : 1
  const name = values[at]
  return name !== undefined && STATE_BUILTINS.has(name) ? { name, args: values.slice(at + 1) } : undefined
}

function applyBuiltin(state: ActorState, values: string[]): ActorState {
  const found = stateBuiltin(values)
  if (found === undefined) return state
  const next: ActorState = { ...state }
  if (found.name === "eval" || found.name === "source" || found.name === ".") {
    for (const variable of ACTOR_VARS) next[variable] = ""
    return next
  }
  const unexport = found.name === "export" && found.args.some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg))
  for (const arg of found.args) {
    const name = arg.split("=", 1)[0] as string
    const variable = ACTOR_VARS.find((candidate) => candidate === name)
    if (variable === undefined) continue
    if (found.name === "export" && !unexport) {
      if (arg.includes("=")) next[variable] = arg.slice(name.length + 1)
    } else next[variable] = ""
  }
  return next
}

/** A bare `NAME=value`: it re-values an exported actor, and an empty one clears even an ambient actor. */
function assignBare(state: ActorState, assignment: string): ActorState {
  const name = assignment.slice(0, assignment.indexOf("="))
  const variable = ACTOR_VARS.find((candidate) => candidate === name)
  if (variable === undefined) return state
  const value = assignment.slice(name.length + 1)
  const current = state[variable]
  if (current === "") return state
  if (current === undefined && value !== "") return state
  return { ...state, [variable]: value }
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
    if (!value?.trim() || /[$`]/.test(value)) return null
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
  "bd claim / `bd update <id> --claim` without BEADS_ACTOR or BD_ACTOR creates undistinguishable dead claims. Set either variable to <harness>/<agent-name>/<session-id> and retry."

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
  "bd create / `bd new` / `bd create-form` without BEADS_ACTOR or BD_ACTOR records the invoking human's git identity in created_by. Owner is always the git identity and never identifies the agent. Set either variable to <harness>/<agent-name>/<session-id> so created_by is attributable, then retry."

const ADVISORY_TEXT =
  "BEADS_ACTOR and BD_ACTOR are unset on this mutating `bd` command. Without an actor, created_by records the invoking human's git identity; Owner is always the git identity and never identifies the agent. Set either variable to <harness>/<agent-name>/<session-id> so writes and claims are attributable, then retry."

/** Decide across command-position segments and recursively executable children. */
export function decideActorParsed(parsed: unknown, env: NodeJS.ProcessEnv = process.env): ActorGateDecision {
  if (parsed === null || typeof parsed !== "object") return { kind: "block", reason: "command could not be parsed" }
  const candidate = parsed as { command?: unknown; nested?: unknown }
  if (typeof candidate.command !== "string" || !Array.isArray(candidate.nested)) {
    return { kind: "block", reason: "command could not be parsed" }
  }
  // Decide on the original command text. Re-joining argv with spaces drops quoting, so a
  // quoted "; bd create" would become a command and prefix assignments would vanish.
  let advisory = false
  const own = decideActorGate(candidate.command, env)
  if (own.kind === "block") return own
  if (own.kind === "advisory") advisory = true
  for (const child of candidate.nested) {
    const decision = decideActorParsed(child, env)
    if (decision.kind === "block") return decision
    if (decision.kind === "advisory") advisory = true
  }
  return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" }
}

export function decideActorGate(command: string, env: NodeJS.ProcessEnv = process.env): ActorGateDecision {
  let advisory = false
  for (const invocation of bdInvocations(command)) {
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
