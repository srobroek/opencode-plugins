/**
 * Claims a session can prove from its own successful `bd` results.
 *
 * The lifecycle nudges about and releases these at the end of a session's turn. The state is
 * plain JSON so it lives in `ctx.storage`: OpenCode runs one plugin instance per
 * location, so module memory would split one session's claims across instances.
 */

import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { type BdInvocation, bdInvocations, flagEnabled, globalValue, invocationActor } from "./bd-actor-gate.ts"
import { planEmbeddedWrites } from "./bd-embedded-write-lock.ts"
import { bdStoreForInvocation, envelopeData } from "./gate-admission.ts"
import { closeInvocations, parse, parsedInvocations, scanShell, tokenizeShell } from "./shell.ts"

export type TrackedClaim = { id: string; actor: string | null; store: string | null }

export type ClaimState = {
  /** Claims keyed by resolved store and bead id. */
  claims: Record<string, TrackedClaim>
  /** Every actor this session wrote under. */
  actors: string[]
}

export function emptyClaimState(): ClaimState {
  return { claims: {}, actors: [] }
}

/** Read a stored value back, dropping anything malformed. */
export function readClaimState(value: unknown): ClaimState {
  const state = emptyClaimState()
  if (value === null || typeof value !== "object") return state
  const record = value as Record<string, unknown>
  if (Array.isArray(record.actors)) state.actors = record.actors.filter((a): a is string => typeof a === "string")
  if (record.claims !== null && typeof record.claims === "object") {
    for (const [key, claim] of Object.entries(record.claims as Record<string, unknown>)) {
      if (claim === null || typeof claim !== "object") continue
      const c = claim as Record<string, unknown>
      if (typeof c.id !== "string") continue
      state.claims[key] = {
        id: c.id,
        actor: typeof c.actor === "string" ? c.actor : null,
        store: typeof c.store === "string" ? c.store : null,
      }
    }
  }
  return state
}

export type ClaimTarget = { key: string; store: string | null; ambiguous?: true }

/** Where the embedded-write planner resolved each write: the store (undefined when it cannot say) and directory. */
type PlannedTargets = Map<string, { store: string | undefined; cwd: string }>

const invocationSignature = (invocation: BdInvocation): string =>
  [invocation.verb, ...invocation.args, "\0", ...invocation.globals].join("\0")

/**
 * Resolve each `bd` write's store the way the write lock does, so a preceding `export BEADS_DIR=…`,
 * `cd` or command-local `BEADS_DIR` selects the ledger the write really lands in.
 */
function plannedTargets(command: string, cwd: string, env: NodeJS.ProcessEnv): PlannedTargets {
  const planned: PlannedTargets = new Map()
  planEmbeddedWrites(command, cwd, env, {
    classify: false,
    observe: ({ invocation, store, cwd: writeCwd }) => {
      const key = invocationSignature(invocation)
      const earlier = planned.get(key)
      // The same write at two different stores is ambiguous.
      planned.set(key, earlier !== undefined && earlier.store !== store ? { store: undefined, cwd: writeCwd } : { store, cwd: writeCwd })
    },
  })
  return planned
}

/** Bead-id-shaped arguments. Deliberately loose; callers intersect with real ids. */
export function beadIdCandidates(command: string): string[] {
  const ids: string[] = []
  for (const token of command.split(/[\s;&|(`'"]+/)) {
    if (token.startsWith("-")) continue
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.\d+)*$/i.test(token)) ids.push(token)
  }
  return ids
}

function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    if (index >= 0) return args[index + 1]
    const inline = args.find((arg) => arg.startsWith(`${name}=`))
    if (inline !== undefined) return inline.slice(name.length + 1)
  }
  return undefined
}

function mutationTargetIds(args: readonly string[]): string[] {
  const ids: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? ""
    if (["--assignee", "-a", "--status", "-s"].includes(token)) {
      index++
      continue
    }
    if (/^(?:--assignee|--status|-a|-s)=/u.test(token) || /^(?:--claim|--json)(?:=|$)/u.test(token)) continue
    // An unknown option may consume later bead-shaped tokens, but it cannot change
    // positional ids already seen. Keep those and stop.
    if (token.startsWith("-")) break
    const [id] = beadIdCandidates(token)
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/** Ids a `bd unclaim` names, skipping the values of its options. */
function unclaimIds(args: readonly string[]): string[] {
  const ids: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? ""
    if (token.startsWith("-")) {
      if (TRANSITION_VALUE_FLAGS[token] === true) index++
      continue
    }
    const [id] = beadIdCandidates(token)
    if (id !== undefined) ids.push(id)
  }
  return ids
}

function claimTarget(
  invocation: BdInvocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
  planned?: PlannedTargets,
): ClaimTarget {
  const localStore = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="))?.slice("BEADS_DIR=".length)
  const global = flagEnabled(invocation.globals, ["--global"])
  const database = globalValue(invocation.globals, ["--database"])
  const db = globalValue(invocation.globals, ["--db"])
  const directory = globalValue(invocation.globals, ["-C", "--directory"])
  // The directory the write runs in after any literal `cd`, as the write planner resolved it:
  // relative `--db`, `-C` and `--directory` values are relative to that, not to the tool's start.
  const plan = planned?.get(invocationSignature(invocation))
  const workdir = plan?.cwd ?? cwd
  const base = directory === undefined ? workdir : resolve(workdir, directory)
  const selector = global
    ? ["global"]
    : database !== undefined
      ? ["database", database]
      : db !== undefined
        ? ["db", resolve(base, db)]
        : directory !== undefined
          ? ["directory", base]
          : undefined
  if (selector !== undefined)
    return { key: `external:${JSON.stringify(selector)}`, store: bdStoreForInvocation(invocation, workdir, env) ?? null }
  const ambient = bdStoreForInvocation(invocation, workdir, env) ?? null
  if (plan !== undefined) {
    // The planner could not name the store (a computed `cd` or `BEADS_DIR`) while the ambient
    // environment points at a ledger: the write may land elsewhere, so the target is ambiguous.
    if (plan.store === undefined && ambient !== null && existsSync(ambient))
      return { key: `ambiguous:${invocationSignature(invocation)}`, store: null, ambiguous: true }
    if (plan.store !== undefined) return { key: plan.store, store: plan.store }
  }
  const store = ambient
  if (store !== null) return { key: store, store }
  return {
    key: `external:${JSON.stringify(["beadsDir", localStore === undefined ? undefined : resolve(cwd, localStore)])}`,
    store: null,
  }
}

function claimKey(target: ClaimTarget, id: string): string {
  return `${target.key}\0${id}`
}

function setClaim(state: ClaimState, target: ClaimTarget, id: string, actor: string | null): void {
  if (target.store !== null) {
    for (const [key, claim] of Object.entries(state.claims)) {
      if (claim.id === id && claim.store === target.store) delete state.claims[key]
    }
  }
  state.claims[claimKey(target, id)] = { id, actor, store: target.store }
}

function deleteClaim(state: ClaimState, target: ClaimTarget, id: string): void {
  delete state.claims[claimKey(target, id)]
  if (target.store === null) return
  for (const [key, claim] of Object.entries(state.claims)) {
    if (claim.id === id && claim.store === target.store) delete state.claims[key]
  }
}

function addActor(state: ClaimState, actor: string): void {
  if (!state.actors.includes(actor)) state.actors.push(actor)
}

const TRANSITION_VALUE_FLAGS: Record<string, true> = {
  "--actor": true,
  "--database": true,
  "--db": true,
  "-C": true,
  "--directory": true,
  "--dolt-auto-commit": true,
  "--mem-profile": true,
  "--acceptance": true,
  "--add-label": true,
  "--append-notes": true,
  "--assignee": true,
  "-a": true,
  "--await-id": true,
  "--body-file": true,
  "--defer": true,
  "--description": true,
  "-d": true,
  "--design": true,
  "--design-file": true,
  "--due": true,
  "--estimate": true,
  "-e": true,
  "--external-ref": true,
  "--if-assignee": true,
  "--if-status": true,
  "--metadata": true,
  "--notes": true,
  "--parent": true,
  "--priority": true,
  "-p": true,
  "--remove-label": true,
  "--session": true,
  "--set-labels": true,
  "--set-metadata": true,
  "--spec-id": true,
  "--status": true,
  "-s": true,
  "--title": true,
  "--type": true,
  "-t": true,
  "--unset-metadata": true,
  "--reason": true,
  "-r": true,
  "--message": true,
}

function transitionFlags(args: string[]): { actorOverride: string | undefined; claim: boolean; help: boolean } {
  let actorOverride: string | undefined
  let claim = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index] as string
    const name = token.split("=", 1)[0] ?? token
    if (TRANSITION_VALUE_FLAGS[name] === true) {
      if (name === "--actor") actorOverride = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[index + 1]
      if (!token.includes("=")) index++
      continue
    }
    if (flagEnabled([token], ["--help", "-h"])) return { actorOverride, claim, help: true }
    if (flagEnabled([token], ["--claim"])) claim = true
  }
  return { actorOverride, claim, help: false }
}

function claimEnabled(invocation: BdInvocation): boolean {
  const flags = transitionFlags(invocation.args)
  if (flagEnabled(invocation.globals, ["--help", "-h"]) || flags.help) return false
  return invocation.verb === "claim" || ((invocation.verb === "update" || invocation.verb === "ready") && flags.claim)
}

/** A claim `bd` confirmed in its own `--json` output: the bead, the holder it reports and the ledger. */
export type ConfirmedClaim = { id: string; actor: string; target: ClaimTarget }

/** A claim command whose shape lets the plugin decide where it lands. `confirmClaims` judges bd's answer. */
export type ClaimPlan = {
  target: ClaimTarget
  /** Beads the command names; empty when bd picks them (`bd ready --claim`). */
  ids: string[]
  /** The actors this invocation could have run as; bd's reported assignee must be one of them. */
  candidates: ReadonlySet<string>
  /** Whether the command asks bd for `--json`; if not, `withJson` adds it right after the verb, at `jsonAt`. */
  json: boolean
  jsonAt: number
}

/** `none`: not a claim. `refused`: a claim the plugin cannot track, and why. */
export type ClaimInspection = { kind: "none" } | { kind: "refused"; reason: string } | { kind: "claim"; plan: ClaimPlan }

/** A word that is, or starts like, a flag choosing a ledger: `-C`, `--db`, `--database`, `--directory`, `--global`, `--dolt-*`. */
const LEDGER_SELECTOR = /^(?:-C|--db|--database|--directory|--global|--dolt-)/u

/**
 * Environment variables that choose which ledger or server bd opens. When the plugin's own
 * process environment sets one, that is the ledger every command of the session means, so it is
 * certain; only a command that sets one to a different value is refused.
 *
 * `path`: the value names a file or directory, so two spellings of one place (a trailing slash, a
 * symlink) are the same ledger and are compared after `realpath`. `scalar`: the value is a port,
 * host or mode, not a place; it is compared as written, because resolving it as a path could make
 * `3307` equal `3306` when the working directory holds symlinks with those names.
 */
const LEDGER_ENV: Record<string, "path" | "scalar"> = {
  BEADS_DIR: "path",
  BEADS_DB: "path",
  BD_DB: "path",
  BD_SOCKET: "path",
  BEADS_DOLT_DATA_DIR: "path",
  BEADS_DOLT_SERVER_SOCKET: "path",
  BEADS_PROXIED_SERVER_ROOT_PATH: "path",
  BEADS_PROXIED_SERVER_CONFIG: "path",
  BEADS_DOLT_PORT: "scalar",
  BEADS_DOLT_SERVER_HOST: "scalar",
  BEADS_DOLT_SERVER_PORT: "scalar",
  BEADS_DOLT_SERVER_MODE: "scalar",
}

const isAssignment = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)

/** Whether two ledger values are the same once relative parts, trailing slashes and symlinks are resolved. */
function samePath(a: string, b: string, cwd: string): boolean {
  const canonical = (value: string): string => {
    const absolute = resolve(cwd, value)
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }
  return canonical(a) === canonical(b)
}

/**
 * Whether the shell passes `word` through as written: no expansion or substitution, and no
 * unquoted glob, brace or `~` character in its source text.
 */
function isLiteral(command: string, word: { start: number; end: number; expands: boolean }): boolean {
  if (word.expands) return false
  let quote: "'" | '"' | undefined
  const raw = command.slice(word.start, word.end)
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] as string
    if (quote === "'") {
      if (char === "'") quote = undefined
    } else if (char === "\\") index++
    else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === "$" || char === "`") return false
    } else if (char === "'" || char === '"') quote = char
    else if ("$`*?[]{}~".includes(char)) return false
  }
  return true
}

/**
 * Decide, from the parsed shell structure, whether `command` is a claim the plugin can track:
 * exactly one simple `bd` command (no list, pipe, subshell, substitution or background) with no
 * ledger selector, flag or variable at all, so the plugin's own pin is the only ledger it can mean.
 * `env` is the environment with that pin; `inherited` the one the user or agent set, before it. Anything else is `refused`, because a
 * claim recorded for the wrong ledger or for a command that did not finish would later release
 * somebody else's bead. A missed heartbeat costs far less than that.
 */
export function inspectClaim(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  { injected, inherited }: { injected?: string; inherited: NodeJS.ProcessEnv },
): ClaimInspection {
  const invocations = bdInvocations(command)
  const claims = invocations.filter(claimEnabled)
  const refuse = (reason: string): ClaimInspection => ({ kind: "refused", reason })
  if (claims.length === 0) {
    // `bdInvocations` does not see a `bd` that runs behind the embedded-write runner's `--`, so a
    // claim typed that way would pass unwarned. The plugin tracks only a plain `bd` command.
    const wrapped = parsedInvocations(parse(command)).some((found) => {
      if (found.verb === undefined || (found.position.executable?.split("/").pop() ?? "") === "bd") return false
      const flags = transitionFlags(found.args)
      return !flags.help && (found.verb === "claim" || ((found.verb === "update" || found.verb === "ready") && flags.claim))
    })
    return wrapped
      ? refuse("it runs bd through the embedded-write runner, and only a plain `bd` command is tracked")
      : { kind: "none" }
  }
  const scan = scanShell(command)
  const [item, ...rest] = scan.items
  if (!scan.complete || scan.substitutions.length > 0 || rest.length > 0 || item?.kind !== "command" || invocations.length !== 1)
    return refuse("it is not a single plain `bd` command (it chains, pipes, nests, substitutes or backgrounds)")
  const [invocation] = claims
  if (invocation === undefined) return refuse("it is not a single plain `bd` command")
  const bdIndex = item.words.findIndex((word) => !word.quoted && (word.value.split("/").pop() ?? word.value) === "bd")
  const prefix = item.words.slice(0, Math.max(bdIndex, 0))
  if (bdIndex < 0) return refuse("it does not start with `bd` (a wrapper or interpreter runs it)")
  if (prefix.some((word) => word.quoted && isAssignment(word.value)))
    return refuse("it has a quoted variable assignment before `bd`; only an unquoted literal BEADS_ACTOR=/BD_ACTOR= prefix is read")
  if (!prefix.every((word) => !word.quoted && isAssignment(word.value)))
    return refuse("it does not start with `bd` (a wrapper or interpreter runs it)")
  // Any word the shell computes (expansion, substitution, glob, brace or `~`) could turn into a
  // ledger selector or an actor at run time, so the plugin cannot say where the claim lands.
  if (item.words.some((word) => !isLiteral(command, word)))
    return refuse("a word of the command is computed by the shell (a variable, substitution, glob, brace or ~)")
  // The plugin does not interpret selectors: any flag or assignment that could choose another
  // ledger, anywhere in the command, leaves the claim untracked.
  if (item.words.slice(bdIndex + 1).some((word) => LEDGER_SELECTOR.test(word.value)))
    return refuse("it carries a ledger selector flag (-C, --db, --database, --directory, --global, --dolt-*)")
  // The plugin's own environment names its ledger, so that is certain. A command may repeat a
  // ledger variable only with the same value (same path once canonical); anything else could pick
  // another ledger, and so could a BEADS_* or BD_* variable the plugin does not know.
  for (const word of prefix.filter((item) => /^(?:BEADS|BD)_(?!ACTOR=)/u.test(item.value))) {
    const at = word.value.indexOf("=")
    const name = word.value.slice(0, at)
    const own = inherited[name] ?? ""
    const kind = LEDGER_ENV[name]
    if (kind === undefined)
      return refuse("it assigns a BEADS_* or BD_* variable other than the actor or a known ledger variable")
    const inline = word.value.slice(at + 1)
    if (own === "" || !(kind === "path" ? samePath(inline, own, cwd) : inline === own))
      return refuse(`it assigns ${name} to a different ledger than the plugin's own environment names`)
  }
  if (invocation.args.includes("--")) return refuse("it uses `--`, so its arguments are not certain")
  // `--json` goes right after the verb, never after the last word: a trailing option that takes a
  // value (`--assignee`, `--notes`) would otherwise swallow it and change what the command does.
  const verbWord = item.words[bdIndex + 1 + invocation.globals.length]
  if (verbWord === undefined || verbWord.value !== invocation.verb || verbWord.quoted)
    return refuse("its verb is not a plain literal word")
  const target = claimTarget(invocation, cwd, env, plannedTargets(command, cwd, env))
  if (target.ambiguous === true) return refuse("its ledger is ambiguous")
  // bd's precedence is flag over environment: an `--actor` anywhere in the argv (a post-verb one
  // is the later, winning flag) is the only actor the invocation can run as. A flag whose value
  // is not a literal leaves no candidate. Otherwise the invocation's own prefix assignment is the
  // only one; the injected and inherited actors apply only when the command names none.
  const flagActor = transitionFlags(invocation.args).actorOverride ?? globalValue(invocation.globals, ["--actor"])
  const ownPrefix = invocation.prefix.some((token) => /^(BEADS_ACTOR|BD_ACTOR)=/.test(token))
  const possible =
    flagActor !== undefined
      ? [/[$`\\\0]/.test(flagActor) ? undefined : flagActor.trim()]
      : ownPrefix
        ? [invocationActor(invocation, env)]
        : [injected, invocationActor(invocation, env)]
  const candidates = new Set<string>()
  for (const actor of possible) if (actor !== undefined && actor !== null && actor !== "") candidates.add(actor)
  return {
    kind: "claim",
    plan: {
      target,
      ids: mutationTargetIds(invocation.args),
      candidates,
      json: flagEnabled([...invocation.globals, ...invocation.args], ["--json"]),
      jsonAt: verbWord.end,
    },
  }
}

/** `command` asking bd for `--json`, added right after the verb so no option's value and no trailing redirect or comment is touched. */
export function withJson(command: string, plan: ClaimPlan): string {
  return plan.json ? command : `${command.slice(0, plan.jsonAt)} --json${command.slice(plan.jsonAt)}`
}

type ReportedIssue = { id: string; status: string; assignee: string }

/** The issue objects in bd's `--json` output: the whole text, else from its first JSON-looking line. */
function reportedIssues(texts: readonly string[]): ReportedIssue[] | undefined {
  for (const text of texts) {
    const lines = text.split("\n")
    const first = lines.findIndex((line) => /^\s*[[{]/u.test(line))
    for (const candidate of [text, first < 0 ? "" : lines.slice(first).join("\n")]) {
      try {
        const data = envelopeData(JSON.parse(candidate))
        const issues = (Array.isArray(data) ? data : [data]).flatMap((item): ReportedIssue[] => {
          const issue = item as { id?: unknown; status?: unknown; assignee?: unknown } | null
          return typeof issue?.id === "string" && typeof issue.status === "string" && typeof issue.assignee === "string"
            ? [{ id: issue.id, status: issue.status, assignee: issue.assignee.trim() }]
            : []
        })
        if (issues.length > 0) return issues
      } catch {
        // Not JSON: try the next reading.
      }
    }
  }
  return undefined
}

/**
 * The claims bd itself confirmed: an issue in its `--json` output with the claimed id, status
 * `in_progress` and an assignee that is one of the plan's candidate actors. `unconfirmed` names
 * the beads that could not be confirmed; `jsonFound` is false when bd printed no issue JSON at all.
 */
export function confirmClaims(
  plan: ClaimPlan,
  texts: readonly string[],
): { confirmed: ConfirmedClaim[]; unconfirmed: string[]; jsonFound: boolean } {
  const issues = reportedIssues(texts)
  if (issues === undefined) return { confirmed: [], unconfirmed: plan.ids, jsonFound: false }
  const wanted = plan.ids.length > 0 ? plan.ids : issues.map((issue) => issue.id)
  const confirmed: ConfirmedClaim[] = []
  const unconfirmed: string[] = []
  for (const id of new Set(wanted)) {
    const issue = issues.find((candidate) => candidate.id === id)
    if (issue !== undefined && issue.status === "in_progress" && plan.candidates.has(issue.assignee))
      confirmed.push({ id, actor: issue.assignee, target: plan.target })
    else unconfirmed.push(id)
  }
  return { confirmed, unconfirmed, jsonFound: true }
}

/**
 * Update `state` from one successful shell result. `command` is the command as the agent wrote
 * it, before any rewrite; `env` the environment it ran under; `confirmed` the claims bd's own
 * output proved (see `confirmClaims`). A claim is recorded only from `confirmed`: a command that
 * assigns, or whose outcome is not proven, never adds one, since recording a guess would hand the
 * lease to the wrong actor. Closes, unclaims and assignments drop claims.
 */
export function recordClaimTransitions(
  state: ClaimState,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  invocations: BdInvocation[],
  confirmed: readonly ConfirmedClaim[] = [],
): void {
  for (const { id, actor, target } of confirmed) {
    addActor(state, actor)
    setClaim(state, target, id, actor)
  }
  const planned = plannedTargets(command, cwd, env)
  const transitions = invocations.flatMap((invocation) => {
    const flags = transitionFlags(invocation.args)
    return flagEnabled(invocation.globals, ["--help", "-h"]) || flags.help ? [] : [{ flags, invocation }]
  })
  const terminalToken = tokenizeShell(command).findLast((token) => token.value !== "\n")?.value
  const safeCdAndBd =
    /^\s*cd\s+[^;&|<>]+&&\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*['"]?bd['"]?\b/u.test(command)
  const direct =
    transitions.length === 1 &&
    terminalToken !== "&" &&
    !/\$\(|[;|<>]/u.test(command) &&
    (!command.includes("&&") || safeCdAndBd)
  const entry = transitions[0]
  if (!direct || entry === undefined) return
  const { invocation } = entry
  const target = claimTarget(invocation, cwd, env, planned)
  for (const close of closeInvocations(command)) {
    for (const id of close.ids) deleteClaim(state, target, id)
  }
  if (invocation.verb === "unclaim") {
    for (const id of unclaimIds(invocation.args)) deleteClaim(state, target, id)
    return
  }
  // An assignment hands the bead to someone and its outcome is not proven here: stop tracking it.
  if (invocation.verb === "assign") {
    const [idToken] = invocation.args
    const [id] = idToken === undefined ? [] : beadIdCandidates(idToken)
    if (id !== undefined) deleteClaim(state, target, id)
    return
  }
  if (invocation.verb !== "update") return
  const status = optionValue(invocation.args, ["--status", "-s"])
  const assignee = optionValue(invocation.args, ["--assignee", "-a"])
  for (const id of mutationTargetIds(invocation.args)) {
    if (status === "closed" || assignee !== undefined) deleteClaim(state, target, id)
  }
}

/** Contention text the embedded store prints; the same command should simply be retried. */
const CONTENTION = [
  /a maintenance operation is running on this workspace: retry when it completes/i,
  /other bd commands are using this workspace: wait for them to finish and retry/i,
  /lock busy: held by another process/i,
  /lock already held by another process/i,
  /workspace gate busy/i,
]

export const CONTENTION_ADVISORY =
  "Beads reported embedded-store contention: another bd process holds this workspace, so the command did not complete. Retrying the same command after a short wait usually succeeds, and the plugin's embedded-write lock serialises writes. `workspace gate unavailable, continuing ungated` is not contention: that command ran."

/** The contention advisory when `output` shows contention, else `undefined`. */
export function contentionAdvisory(output: string): string | undefined {
  return CONTENTION.some((pattern) => pattern.test(output)) ? CONTENTION_ADVISORY : undefined
}
