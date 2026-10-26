/**
 * Guarded release of the claims a session still holds when it stops.
 *
 * Every release is `bd unclaim --if-assignee <holder>`: a compare-and-swap, so a late
 * release can never clobber a worker that picked the bead up in the meantime. A parked
 * status (blocked, deferred) is put back with `--if-status open --if-assignee ''`, so a
 * new claim between the two commands is not overwritten either.
 */

import { dirname } from "node:path"
import type { ClaimState, TrackedClaim } from "./claims.ts"
import { type BdRun, envelopeData, lifecycleBdEnvironment, parseTrailingJson } from "./gate-admission.ts"

/** Longest advisory list before it stops being read. */
const MAX_LISTED = 8

/** The fixed ceiling on a detached release; nothing of it outlives this. */
export const RELEASE_CEILING_MS = 120_000

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** Statuses a claim can still be held in. */
const HELD_STATUSES = ["open", "in_progress", "blocked", "deferred"]

/** Issue types a release may touch. Gates, messages and molecules are never auto-released. */
const RELEASABLE_TYPES = ["task", "epic", "bug", "feature", "chore"]

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function actorOf(env: NodeJS.ProcessEnv): string {
  return env.BD_ACTOR?.trim() || env.BEADS_ACTOR?.trim() || ""
}

/**
 * The argv of one guarded release, or `undefined` when an identifier is unsafe, the
 * releasing actor is unknown, or bd lacks `--if-assignee`.
 */
export function releaseClaimArgs(
  id: string,
  holder: string,
  env: NodeJS.ProcessEnv,
  releasedAt = new Date().toISOString(),
  casSupported = true,
): string[] | undefined {
  const actor = actorOf(env)
  if (!casSupported) return undefined
  if (!SAFE_IDENTIFIER.test(id) || !SAFE_IDENTIFIER.test(holder) || !SAFE_IDENTIFIER.test(actor)) return undefined
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(releasedAt)) return undefined
  const reason = `session release by ${actor} at ${releasedAt}; previous holder ${holder}`
  return ["unclaim", id, "--reason", reason, "--if-assignee", holder]
}

/** The same release as a shell command, for advisories. */
export function releaseClaimCommand(
  id: string,
  holder: string,
  env: NodeJS.ProcessEnv,
  releasedAt = new Date().toISOString(),
  casSupported = true,
  store?: string,
): string | undefined {
  const args = releaseClaimArgs(id, holder, env, releasedAt, casSupported)
  if (args === undefined) return undefined
  const actor = actorOf(env)
  const assignments = [`BEADS_ACTOR=${shellQuote(actor)}`, `BD_ACTOR=${shellQuote(actor)}`]
  if (store !== undefined) assignments.unshift(`BEADS_DIR=${shellQuote(store)}`)
  return [...assignments, "bd", ...args.map(shellQuote)].join(" ")
}

/**
 * Put a parked status back after `bd unclaim` reset it to open. An in-progress claim
 * needs nothing: unclaim already left it open and unassigned.
 */
export function restoreStatusArgs(id: string, status: string): string[] | undefined {
  if (status === "blocked" || status === "deferred")
    return ["update", id, "--status", status, "--if-status", "open", "--if-assignee", ""]
  return undefined
}

/** What the agent is told when it stops with claims held. */
export function heldClaimsAdvisory(state: ClaimState, casSupported = true, releasedAt = new Date().toISOString()): string | undefined {
  const claims = Object.values(state.claims)
  if (claims.length === 0) return undefined
  const lines = ["Beads claims still held as this turn ends:"]
  for (const claim of claims.slice(0, MAX_LISTED)) {
    lines.push(`- ${claim.id}${claim.actor === null ? "" : ` [${claim.actor}]`} claim recorded by this session`)
    const release =
      claim.actor === null || claim.store === null || !state.actors.includes(claim.actor)
        ? undefined
        : releaseClaimCommand(claim.id, claim.actor, { BD_ACTOR: claim.actor }, releasedAt, casSupported, claim.store)
    if (release !== undefined) lines.push(`  Release with: ${release}`)
    else
      lines.push(
        casSupported
          ? "  Release unavailable: the effective actor or store is missing or ambiguous; verify the current assignee before releasing."
          : "  Release unavailable: bd >= 1.3 is required for atomic --if-assignee; the claim remains assigned.",
      )
  }
  if (claims.length > MAX_LISTED) lines.push(`- ...and ${claims.length - MAX_LISTED} more`)
  lines.push(
    "Close what is finished with a factual --reason, release only with the guarded command above, and write residual context onto any bead whose work continues elsewhere (bd comments add <id> \"...\"). File remaining or discovered work as its own bead. If this session stops again with these claims held, the beads plugin releases them with the guarded command.",
  )
  return lines.join("\n")
}

export type UnverifiedRelease = { claim: TrackedClaim; message: string }

export type ReleaseOutcome = {
  /** Keys of claims that were released. */
  released: string[]
  /** Keys of claims bd no longer shows as this holder's; they are no longer tracked. */
  dropped: string[]
  /** Claims whose release could not be verified, and why. They stay tracked. */
  unverified: Array<UnverifiedRelease & { key: string }>
  /** False once bd rejected `--if-assignee`. */
  casSupported: boolean
}

const UNKNOWN_FLAG =
  /(?:unknown|unrecognized|unsupported|invalid|unexpected).*(?:flag|option)|(?:flag|option).*(?:unknown|unrecognized|unsupported|invalid|unexpected)/i

/** The environment one claim's `bd` calls run under: its own store and its holder as actor. */
export function claimEnvironment(claim: { actor: string; store: string }, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = lifecycleBdEnvironment(dirname(claim.store), { ...base, BD_ACTOR: claim.actor, BEADS_ACTOR: claim.actor })
  env.BEADS_DIR = claim.store
  return env
}

/**
 * Release every claim in `entries` that bd still shows as held by its recorded actor.
 * Every `bd` call shares `deadline`. One claim's failure never stops the others.
 */
export async function releaseClaims(
  entries: ReadonlyArray<[string, TrackedClaim]>,
  run: BdRun,
  deadline: number,
  base: NodeJS.ProcessEnv,
  casSupported = true,
  now: () => string = () => new Date().toISOString(),
): Promise<ReleaseOutcome> {
  const outcome: ReleaseOutcome = { released: [], dropped: [], unverified: [], casSupported }
  const report = (key: string, claim: TrackedClaim, message: string) => outcome.unverified.push({ key, claim, message })
  for (const [key, claim] of entries) {
    const { actor, store } = claim
    if (actor === null || store === null) {
      report(key, claim, `the actor or store of ${claim.id} could not be proven, so no automatic release was attempted`)
      continue
    }
    try {
      const env = claimEnvironment({ actor, store }, base)
      const cwd = dirname(store)
      const shown = await run(cwd, ["show", claim.id, "--json"], deadline, env)
      if (!("output" in shown)) {
        report(key, claim, `the claim read for ${claim.id} was not verified: ${shown.failure}`)
        continue
      }
      const rows = envelopeData(parseTrailingJson(shown.output))
      if (!Array.isArray(rows)) {
        report(key, claim, `the claim read for ${claim.id} returned malformed data; release was refused`)
        continue
      }
      const bead = rows.find((row) => row !== null && typeof row === "object" && (row as { id?: unknown }).id === claim.id) as
        | Record<string, unknown>
        | undefined
      if (bead === undefined || bead.assignee !== actor || !HELD_STATUSES.includes(String(bead.status))) {
        outcome.dropped.push(key)
        continue
      }
      if (!RELEASABLE_TYPES.includes(String(bead.issue_type))) {
        report(key, claim, `${claim.id} is a ${String(bead.issue_type)}, which is never released automatically`)
        continue
      }
      if (!outcome.casSupported) {
        report(key, claim, `${claim.id} remains assigned: bd >= 1.3 is required for atomic --if-assignee`)
        continue
      }
      const release = releaseClaimArgs(claim.id, actor, env, now(), true)
      if (release === undefined) {
        report(key, claim, `${claim.id} or its holder is not a safe identifier; release was refused`)
        continue
      }
      const released = await run(cwd, release, deadline, env)
      if (!("output" in released)) {
        if (/--if-assignee/i.test(released.failure) && UNKNOWN_FLAG.test(released.failure)) {
          outcome.casSupported = false
          report(key, claim, `${claim.id} remains assigned: bd >= 1.3 is required for atomic --if-assignee`)
        } else report(key, claim, `the release of ${claim.id} was not verified: ${released.failure}`)
        continue
      }
      const restore = restoreStatusArgs(claim.id, String(bead.status))
      if (restore !== undefined) {
        const restored = await run(cwd, restore, deadline, env)
        if (!("output" in restored)) {
          // The claim is released; only the parked status is unverified.
          outcome.released.push(key)
          report(key, claim, `${claim.id} was released, but restoring its ${String(bead.status)} status was not verified: ${restored.failure}`)
          continue
        }
      }
      outcome.released.push(key)
    } catch (error) {
      report(key, claim, `the release of ${claim.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return outcome
}

/** What a release reports about the claims of `subject`, such as "finished subagent session ses_1". */
export function releaseReport(
  subject: string,
  claims: Record<string, TrackedClaim>,
  outcome: ReleaseOutcome,
  releasedAt = new Date().toISOString(),
): string | undefined {
  const released = outcome.released
    .filter((key) => !outcome.unverified.some((entry) => entry.key === key))
    .map((key) => claims[key]?.id)
    .filter((id): id is string => id !== undefined)
  const lines: string[] = []
  if (released.length > 0)
    lines.push(`Beads: the claims of ${subject} were released (guarded bd unclaim): ${released.join(", ")}.`)
  if (outcome.unverified.length > 0) {
    lines.push(
      `Beads claims of ${subject} were not verified as released, so each may still be assigned. Nothing still runs for these claims:`,
    )
    for (const { claim, message } of outcome.unverified.slice(0, MAX_LISTED)) {
      lines.push(`- ${claim.id}${claim.actor === null ? "" : ` [${claim.actor}]`}: ${message}`)
      const store = claim.store === null ? "" : `BEADS_DIR=${shellQuote(claim.store)} `
      lines.push(`  Check with: ${store}bd show ${shellQuote(claim.id)} --json`)
      const release =
        claim.actor === null
          ? undefined
          : releaseClaimCommand(
              claim.id,
              claim.actor,
              { BD_ACTOR: claim.actor },
              releasedAt,
              outcome.casSupported,
              claim.store ?? undefined,
            )
      if (release !== undefined) lines.push(`  Release with: ${release}`)
    }
    if (outcome.unverified.length > MAX_LISTED) lines.push(`- ...and ${outcome.unverified.length - MAX_LISTED} more`)
    lines.push(
      "A release cut off by its deadline may already have applied, so check each bead before acting on it. Then close finished work, release only with the guarded command above, or hand the bead on with a comment.",
    )
  }
  return lines.length === 0 ? undefined : lines.join("\n")
}
