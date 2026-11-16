/**
 * Claims a session can prove from its own successful `bd` results.
 *
 * The lifecycle nudges about and releases these at the end of a session's turn. The state is
 * plain JSON so it lives in `ctx.storage`: OpenCode runs one plugin instance per
 * location, so module memory would split one session's claims across instances.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { type BdInvocation, flagEnabled, globalValue, invocationActor } from "./bd-actor-gate.ts"
import { planEmbeddedWrites } from "./bd-embedded-write-lock.ts"
import { claimedIds, claimedTextIds } from "./bd-lease-gate.ts"
import { type BdRun, bdStoreForInvocation, envelopeData } from "./gate-admission.ts"
import { closeInvocations, tokenizeShell } from "./shell.ts"

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

type ClaimTarget = { key: string; store: string | null; ambiguous?: true }

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

/** One bead a claim-enabled invocation may have claimed, and the key its holder is stored under. */
export type ClaimLookup = {
  invocation: BdInvocation
  id: string
  key: string
  /** The directory and store the claiming write ran against, as the write planner resolved them. */
  cwd: string
  store: string | undefined
  /** The actors this session's invocation could have run as; bd's answer must be one of them. */
  candidates: ReadonlySet<string>
}

/** The holder of each claimed bead, as bd itself reports it. A bead missing from the map was not confirmed. */
export type ClaimHolders = ReadonlyMap<string, string>

function claimEnabled(invocation: BdInvocation): boolean {
  const flags = transitionFlags(invocation.args)
  if (flagEnabled(invocation.globals, ["--help", "-h"]) || flags.help) return false
  return invocation.verb === "claim" || ((invocation.verb === "update" || invocation.verb === "ready") && flags.claim)
}

/**
 * Every bead a successful command may have claimed, with the ledger it targets. The caller asks
 * bd who holds each one. A holder counts only when it is an actor this session's invocation
 * could have used (`injected`, an explicit `--actor`, or the actor its environment names), so a
 * bead the same command then reassigns to someone else is not adopted as this session's claim.
 */
export function claimLookups(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: string,
  invocations: BdInvocation[],
  injected?: string,
): ClaimLookup[] {
  const outputIds = claimedIds(output)
  const planned = plannedTargets(command, cwd, env)
  const found: ClaimLookup[] = []
  for (const invocation of invocations) {
    if (!claimEnabled(invocation)) continue
    const target = claimTarget(invocation, cwd, env, planned)
    if (target.ambiguous === true) continue
    const candidates = new Set<string>()
    // bd's precedence is flag over environment: an `--actor` anywhere in the argv (a post-verb one
    // is the later, winning flag) is the only actor the invocation can run as. A flag whose value
    // is not a literal leaves no candidate. Otherwise the invocation's own prefix assignment is the
    // only one; injected, inherited and conditionally exported actors never apply to either.
    const flagActor = transitionFlags(invocation.args).actorOverride ?? globalValue(invocation.globals, ["--actor"])
    const ownPrefix = invocation.prefix.some((token) => /^(BEADS_ACTOR|BD_ACTOR)=/.test(token))
    const possible =
      flagActor !== undefined
        ? [/[$`\\\0]/.test(flagActor) ? undefined : flagActor.trim()]
        : ownPrefix
          ? [invocationActor(invocation, env)]
          : [injected, invocationActor(invocation, env), ...invocation.conditional]
    for (const actor of possible) if (actor !== undefined && actor !== null && actor !== "") candidates.add(actor)
    const plan = planned.get(invocationSignature(invocation))
    const direct = mutationTargetIds(invocation.args)
    for (const id of new Set(direct.length > 0 ? direct : outputIds))
      found.push({ invocation, id, key: claimKey(target, id), cwd: plan?.cwd ?? cwd, store: plan?.store, candidates })
  }
  return found
}

/**
 * Ask bd who holds each looked-up bead (`bd show <id> --json`, against the store and directory
 * the claiming write targeted). Beads bd cannot answer for, or reports under an actor outside
 * the lookup's candidates, are left out of the map.
 */
export async function readClaimHolders(
  lookups: ClaimLookup[],
  env: NodeJS.ProcessEnv,
  run: BdRun,
  deadline: number,
): Promise<Map<string, string>> {
  const holders = new Map<string, string>()
  const seen = new Set<string>()
  for (const { invocation, id, key, cwd, store, candidates } of lookups) {
    if (seen.has(key)) continue
    seen.add(key)
    const local = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="))
    const queryEnv =
      store !== undefined
        ? { ...env, BEADS_DIR: store }
        : local === undefined
          ? env
          : { ...env, BEADS_DIR: resolve(cwd, local.slice("BEADS_DIR=".length)) }
    const result = await run(cwd, [...invocation.globals, "show", id, "--json"], deadline, queryEnv)
    if ("failure" in result) continue
    try {
      const data = envelopeData(JSON.parse(result.output))
      const issue = (Array.isArray(data) ? data[0] : data) as { assignee?: unknown } | undefined
      const assignee = typeof issue?.assignee === "string" ? issue.assignee.trim() : ""
      if (assignee !== "" && candidates.has(assignee)) holders.set(key, assignee)
    } catch {
      // Unreadable output: leave the bead untracked.
    }
  }
  return holders
}

/**
 * Update `state` from one successful shell result. `command` is the command as the
 * agent wrote it, before any rewrite; `env` the environment it ran under; `holders` who bd
 * says holds each claimed bead. Returns the beads whose holder could not be confirmed: those
 * are not tracked, since recording a guess would hand the lease to the wrong actor.
 */
export function recordClaimTransitions(
  state: ClaimState,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: string,
  invocations: BdInvocation[],
  holders: ClaimHolders = new Map(),
): string[] {
  const unreadable: string[] = []
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
  const allOutputIds = new Set(claimedIds(output))
  const labeledOutputIds = new Set(claimedTextIds(output))
  const track = (target: ClaimTarget, id: string): void => {
    const holder = holders.get(claimKey(target, id))
    if (holder === undefined) {
      unreadable.push(id)
      return
    }
    addActor(state, holder)
    setClaim(state, target, id, holder)
  }
  for (const { invocation } of transitions) {
    if (!claimEnabled(invocation)) continue
    const directIds = mutationTargetIds(invocation.args)
    const target = claimTarget(invocation, cwd, env, planned)
    if (direct) {
      for (const id of directIds.length > 0 ? directIds : allOutputIds) track(target, id)
      continue
    }
    for (const id of directIds) if (labeledOutputIds.has(id)) track(target, id)
  }
  if (!direct) return unreadable
  const entry = transitions[0]
  if (entry === undefined) return unreadable
  const { invocation } = entry
  const target = claimTarget(invocation, cwd, env, planned)
  for (const close of closeInvocations(command)) {
    for (const id of close.ids) deleteClaim(state, target, id)
  }
  if (invocation.verb === "unclaim") {
    for (const id of unclaimIds(invocation.args)) deleteClaim(state, target, id)
    return unreadable
  }
  if (invocation.verb === "assign") {
    const [idToken, assignee] = invocation.args
    const [id] = idToken === undefined ? [] : beadIdCandidates(idToken)
    if (id !== undefined && assignee !== undefined) {
      if (state.actors.includes(assignee)) setClaim(state, target, id, assignee)
      else deleteClaim(state, target, id)
    }
    return unreadable
  }
  if (invocation.verb !== "update") return unreadable
  const status = optionValue(invocation.args, ["--status", "-s"])
  const assignee = optionValue(invocation.args, ["--assignee", "-a"])
  for (const id of mutationTargetIds(invocation.args)) {
    if (status === "closed" || assignee === "") deleteClaim(state, target, id)
    else if (assignee !== undefined) {
      if (state.actors.includes(assignee)) setClaim(state, target, id, assignee)
      else deleteClaim(state, target, id)
    }
  }
  return unreadable
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
