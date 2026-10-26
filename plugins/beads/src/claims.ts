/**
 * Claims a session can prove from its own successful `bd` results.
 *
 * The lifecycle nudges about and releases these at the end of a session's turn. The state is
 * plain JSON so it lives in `ctx.storage`: OpenCode runs one plugin instance per
 * location, so module memory would split one session's claims across instances.
 */

import { resolve } from "node:path"
import { type BdInvocation, flagEnabled, globalValue, invocationActor } from "./bd-actor-gate.ts"
import { claimedIds, claimedTextIds } from "./bd-lease-gate.ts"
import { bdStoreForInvocation } from "./gate-admission.ts"
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

type ClaimTarget = { key: string; store: string | null }

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

function claimTarget(invocation: BdInvocation, cwd: string, env: NodeJS.ProcessEnv): ClaimTarget {
  const localStore = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="))?.slice("BEADS_DIR=".length)
  const global = flagEnabled(invocation.globals, ["--global"])
  const database = globalValue(invocation.globals, ["--database"])
  const db = globalValue(invocation.globals, ["--db"])
  const directory = globalValue(invocation.globals, ["-C", "--directory"])
  const base = directory === undefined ? cwd : resolve(cwd, directory)
  const selector = global
    ? ["global"]
    : database !== undefined
      ? ["database", database]
      : db !== undefined
        ? ["db", resolve(base, db)]
        : directory !== undefined
          ? ["directory", base]
          : undefined
  const store = bdStoreForInvocation(invocation, cwd, env) ?? null
  if (selector !== undefined) return { key: `external:${JSON.stringify(selector)}`, store }
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

/**
 * Update `state` from one successful shell result. `command` is the command as the
 * agent wrote it, before any rewrite; `env` the environment it ran under.
 */
export function recordClaimTransitions(
  state: ClaimState,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: string,
  invocations: BdInvocation[],
): void {
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
  const claims = transitions.flatMap(({ flags, invocation }) => {
    const enabled =
      invocation.verb === "claim" || ((invocation.verb === "update" || invocation.verb === "ready") && flags.claim)
    const actor = enabled ? (flags.actorOverride ?? invocationActor(invocation, env)) : null
    return actor === null
      ? []
      : [{ actor, directIds: mutationTargetIds(invocation.args), target: claimTarget(invocation, cwd, env) }]
  })
  const actorsByClaim = new Map<string, Set<string>>()
  for (const { actor, directIds, target } of claims) {
    for (const id of directIds) {
      const key = claimKey(target, id)
      const actors = actorsByClaim.get(key) ?? new Set<string>()
      actors.add(actor)
      actorsByClaim.set(key, actors)
    }
  }
  for (const { actor, directIds, target } of claims) {
    if (direct) {
      addActor(state, actor)
      for (const id of directIds.length > 0 ? directIds : allOutputIds) setClaim(state, target, id, actor)
      continue
    }
    for (const id of directIds) {
      if (!labeledOutputIds.has(id)) continue
      const actors = actorsByClaim.get(claimKey(target, id))
      addActor(state, actor)
      setClaim(state, target, id, actors?.size === 1 ? actor : null)
    }
  }
  if (!direct) return
  const entry = transitions[0]
  if (entry === undefined) return
  const { invocation } = entry
  const target = claimTarget(invocation, cwd, env)
  for (const close of closeInvocations(command)) {
    for (const id of close.ids) deleteClaim(state, target, id)
  }
  if (invocation.verb === "unclaim") {
    for (const id of unclaimIds(invocation.args)) deleteClaim(state, target, id)
    return
  }
  if (invocation.verb === "assign") {
    const [idToken, assignee] = invocation.args
    const [id] = idToken === undefined ? [] : beadIdCandidates(idToken)
    if (id !== undefined && assignee !== undefined) {
      if (state.actors.includes(assignee)) setClaim(state, target, id, assignee)
      else deleteClaim(state, target, id)
    }
    return
  }
  if (invocation.verb !== "update") return
  const status = optionValue(invocation.args, ["--status", "-s"])
  const assignee = optionValue(invocation.args, ["--assignee", "-a"])
  for (const id of mutationTargetIds(invocation.args)) {
    if (status === "closed" || assignee === "") deleteClaim(state, target, id)
    else if (assignee !== undefined) {
      if (state.actors.includes(assignee)) setClaim(state, target, id, assignee)
      else deleteClaim(state, target, id)
    }
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
  "Beads: this is embedded-store contention, not a failure. Wait briefly and retry the same command, up to three attempts, then report what still failed. Do not escalate it, report the run as blocked, or build your own lock, wrapper or retry helper: the plugin's embedded-write lock already serialises writes. `workspace gate unavailable, continuing ungated` is NOT contention: that command ran. The beads-contention-retry skill has the full policy."

/** The contention advisory when `output` shows contention, else `undefined`. */
export function contentionAdvisory(output: string): string | undefined {
  return CONTENTION.some((pattern) => pattern.test(output)) ? CONTENTION_ADVISORY : undefined
}
