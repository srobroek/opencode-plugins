/**
 * Cleanup that did not finish inside `delivery_land` is retried by delivery itself, for
 * worktrees nothing else owns.
 *
 * With an active Beads ledger the beads close only after the land, so inline cleanup is
 * always skipped there; relying on the agent to call `delivery_cleanup` afterwards is the
 * original leak. A receipt whose worktree is still there is pending. Delivery retries it
 * when a session finishes a turn (`session.execution.*`, `session.idle`, and the
 * `experimental.idle` hook), with the same proofs `delivery_cleanup` applies, and nudges the
 * session that landed it once while its beads are still open.
 *
 * One remover per worktree. A lane's worktree is owned by `subagent-worktree`, which writes a
 * claim file under the git common directory. While a claim exists (or cannot be read) delivery
 * never removes the worktree: it records the landing, and any denial, in a landing record on
 * disk next to the claim, and the owner reads that record before it acts. For a worktree no one
 * claims, ownership (the claim file and every page of the sessions in the directory) is checked
 * again immediately before the removal, after all proofs.
 *
 * `pendingCleanupAction` is the pure decision; `createPendingCleanup` gathers the facts and
 * carries it out.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { canonicalCheckout, evictSessions, type SessionApi } from "@srobroek/opencode-lib/session-eviction"
import {
  canonicalDirectory,
  type LandingRecord,
  landingsFor,
  listLandings,
  type Ownership,
  ownershipOf,
  readClaim,
  readLanding,
  removeLanding,
  writeLanding,
} from "@srobroek/opencode-lib/worktree-claims"
import { holdsState, type LockOptions, lockedWorktreeRemoval, lockedWrite, setHold } from "@srobroek/opencode-lib/worktree-locks"
import { ownershipDeferral } from "./auto-cleanup.ts"
import {
  CLEANUP_BOUNDS,
  type CleanupCoordination,
  type CleanupDeps,
  type CleanupFailure,
  type CleanupIdentity,
  type CleanupResult,
  cleanupDelivery,
  type HostWorktrees,
  ledgerState,
  type RemovalFacts,
} from "./cleanup.ts"
import {
  type CloneEntry,
  cloneRegistryFile,
  readRegistry,
  registryFiles,
  updateRegistry,
  withoutReceipts,
  withReceipts,
} from "./clone-registry.ts"
import { inClone } from "./land.ts"
import {
  closeoutCommands,
  type GitRunner,
  type LandingReceipt,
  listReceipts,
  readReceipt,
  receiptDirectory,
  repoKey,
  repositoryContext,
} from "./landing-receipt.ts"

/** The same receipt is not retried within this window: an event and the idle hook fire for one turn end. */
export const RETRY_WINDOW_MS = 5_000
export const DEBOUNCE_MS = 2_000
const MAX_PER_PASS = 20
const MAX_SESSION_PAGES = 20

export type PendingAction = "retry" | "nudge" | "done" | "hold" | "skip"

export type PendingFacts = {
  /** The receipt's worktree is already gone. */
  worktreeGone: boolean
  /** Cleanup already succeeded for this receipt in this process. */
  done: boolean
  /** Why an owner or a running session keeps the worktree; undefined when nothing does. */
  hold: string | undefined
  /** `open`: a bead is not closed yet. `closed`: all are, or the ledger is inactive. */
  beads: "open" | "closed" | "unknown"
  /** Retried within {@link RETRY_WINDOW_MS}. */
  recentlyTried: boolean
  /** This turn end belongs to the session that ran `delivery_land`. */
  landingSession: boolean
  /** The trigger is an idle: the session has stopped. Nudges are sent only then. */
  idle: boolean
  /** The nudge for this receipt was already sent. */
  nudged: boolean
  /** The cleanup was denied; only an authorized explicit `delivery_cleanup` call re-arms it. */
  denied: boolean
}

export function pendingCleanupAction(
  receipt: Pick<LandingReceipt, "worktree">,
  facts: PendingFacts,
): { action: PendingAction; reason: string } {
  if (facts.done) return { action: "skip", reason: "already cleaned" }
  if (facts.denied) return { action: "skip", reason: "cleanup was denied; call delivery_cleanup to re-arm it" }
  if (receipt.worktree.path === null || receipt.worktree.removed) return { action: "skip", reason: "nothing to remove" }
  if (facts.worktreeGone) return { action: "done", reason: "the worktree is already gone" }
  if (facts.hold !== undefined) return { action: "hold", reason: facts.hold }
  if (facts.recentlyTried) return { action: "skip", reason: "tried a moment ago" }
  if (facts.beads === "open") {
    if (facts.nudged) return { action: "skip", reason: "beads open; nudge already sent" }
    if (!facts.landingSession || !facts.idle) return { action: "skip", reason: "beads open; waiting for the landing session to go idle" }
    return { action: "nudge", reason: "beads still open when the landing session went idle" }
  }
  return { action: "retry", reason: facts.beads === "closed" ? "beads closed" : "ledger state unknown; the proofs decide" }
}

/**
 * The nudge text: which beads to close, with the commands. A reminder for a landing in another
 * repository runs each command in that clone (`scope` is its root), with the session's bead pin dropped.
 */
export function nudgeText(receipt: LandingReceipt, receiptPath: string, scope?: string): string {
  const sha = receipt.pr.mergeCommitOid ?? "missing"
  const commands = receipt.beads.ids.flatMap((id) => {
    const { update, close } = closeoutCommands(id, receipt.pr.number, sha, receiptPath)
    return [update, close].map((command) => (scope === undefined ? command : inClone(scope, command)))
  })
  return `<system-reminder>Landed PR #${receipt.pr.number}: close beads ${receipt.beads.ids.join(", ")} (commands: ${commands.join("; ")}) so its worktree can be cleaned up.</system-reminder>`
}

/** Pending receipts: not cleaned, not superseded by a later receipt. Pure. */
export function pendingReceipts(receipts: readonly LandingReceipt[]): LandingReceipt[] {
  const superseded = new Set(receipts.flatMap((receipt) => (receipt.supersedes === null ? [] : [receipt.supersedes])))
  return receipts.filter(
    (receipt) =>
      receipt.outcome === "landed" &&
      receipt.worktree.path !== null &&
      !receipt.worktree.removed &&
      !superseded.has(receipt.receiptId),
  )
}

/**
 * Which receipts one pass looks at. Receipts that need no attempt (denied, or owned by a lane)
 * do not take a slot, and the rest are ordered by when they were last looked at, so a few that
 * stay held cannot starve the others. Pure.
 */
export function selectWindow<T extends { receiptId: string }>(
  candidates: readonly T[],
  options: { skip: (candidate: T) => boolean; lastAttempt: (candidate: T) => number | undefined; limit: number },
): T[] {
  return candidates
    .filter((candidate) => !options.skip(candidate))
    .map((candidate, index) => ({ candidate, index, at: options.lastAttempt(candidate) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1))
    .slice(0, options.limit)
    .map((entry) => entry.candidate)
}

/**
 * Positive evidence that a receipt needs no more cleanup: it is readable and cleaned, or a readable
 * later receipt supersedes it. A missing directory or an unreadable receipt is never evidence.
 */
export function receiptSettled(directory: string, receiptId: string): boolean {
  try {
    const own = readReceipt(resolve(directory, `${receiptId}.json`))
    if (!own.ok) return false
    if (own.receipt.outcome === "cleaned" || own.receipt.worktree.removed) return true
    return listReceipts(directory).some((receipt) => receipt.supersedes === receiptId)
  } catch {
    return false
  }
}

/** An explicit `delivery_cleanup` was authorized but its target belongs to a lane: nothing is removed here. */
export class CleanupDeferred extends Error {
  constructor(readonly deferred: string) {
    super(deferred)
    this.name = "CleanupDeferred"
  }
}

/** The text for a worktree an owner removes later, or undefined when delivery may remove it. Pure. */
export function explicitDeferral(ownership: Ownership): string | undefined {
  const why = ownershipDeferral(ownership)
  if (why === undefined) return undefined
  return ownership.owner === "lane" ? `${why}; removed by its owner once finished` : `${why}; not removed until it can be read`
}

/**
 * `authorize` for an explicit `delivery_cleanup` call. A refused call is a new denial, whatever
 * came before. Once authorized, an earlier denial is cleared (so the owner may proceed) and, if a
 * lane owns the worktree, delivery stops there with {@link CleanupDeferred}: one remover per worktree.
 */
/** What `cleanupDelivery` hands `authorize`. */
export type ExplicitRequest = { worktree: string; branch?: string; pr?: number }

export async function authorizeExplicit(
  pending:
    | {
        deny: (worktree: string, sessionID: string) => Promise<void>
        arm: (worktree: string) => Promise<void>
        ownership: (worktree: string) => Ownership
      }
    | undefined,
  ask: (request: ExplicitRequest) => Promise<void>,
  sessionID: string,
  request: ExplicitRequest,
): Promise<void> {
  try {
    await ask(request)
  } catch (error) {
    await pending?.deny(request.worktree, sessionID).catch(() => {})
    throw error
  }
  await pending?.arm(request.worktree).catch(() => {})
  const deferred = pending === undefined ? undefined : explicitDeferral(pending.ownership(request.worktree))
  if (deferred !== undefined) throw new CleanupDeferred(deferred)
}

/** One entry of the idle hook's `background` list. */
export type BackgroundJob = { kind: string; sessionID?: string; childSessionID?: string; shellID?: string; command?: string }

export type PendingDeps = {
  ctx: Context
  cwd: string
  env: NodeJS.ProcessEnv
  host: () => HostWorktrees | undefined
  /** The host's worktree registry of another project; absent when the host has none. */
  hostIn?: (projectID: string) => HostWorktrees | undefined
  /** Whether the host has a worktree registry at all, whatever project the session is in. */
  hostCapable?: () => boolean
  now?: () => number
  debounceMs?: number
  /** Receipts looked at per pass. */
  maxPerPass?: number
  /** Test seam: the runner, bounds and clock the cleanup proofs use. */
  cleanup?: Pick<CleanupDeps, "run" | "bounds" | "now">
  /** Test seam: the git runner the repository observations use. */
  observe?: GitRunner
  /** Test seam: the on-disk lock (attempts, ttl, clock, liveness). */
  lock?: Partial<LockOptions>
}

/** What one repository's coordination reads and writes, and where. */
export type CoordinationDeps = {
  ctx: Context
  env: NodeJS.ProcessEnv
  /** The checkout sessions are moved to when the common directory names none. */
  root: string
  /** The git common directory, where claims, landing records, holds and locks live; null if it cannot be resolved. */
  commonDir: () => string | null
  /** The key this repository's receipts are filed under; null if it cannot be resolved. */
  key: () => string | null
  /** The host project the session lookups are filtered by; undefined looks in every project. Read on every use. */
  projectID: () => string | undefined
  now: () => number
  /** Test seam: the on-disk lock (attempts, ttl, clock, liveness). */
  lock?: Partial<LockOptions>
}

/**
 * Every per-repository piece of the cleanup coordination: lane ownership, landing records,
 * denials, holds, the removal lock, the session lookups and the receipts filed for that
 * repository. All of it lives under one git common directory, so a remover must use the
 * coordination of the repository whose worktree it removes, never the session's by default.
 */
export function repositoryCoordination(deps: CoordinationDeps) {
  const { ctx, env, now, commonDir } = deps
  /** Worktrees whose hold could not be recorded: nothing is removed from them until a later write succeeds. */
  const unsafe = new Map<string, string>()
  /** Set when this turn end's running work could not be recorded at all: nothing is removed until a later turn end records it. */
  let holdsUnknown: string | undefined
  /** Denials that could not be written to disk, until an authorized re-arm. */
  const deniedInMemory = new Map<string, string>()

  /** Where this repository's receipts are filed; null if its key cannot be resolved. */
  const receiptsDirectory = (): string | null => {
    const key = deps.key()
    return key === null ? null : resolve(receiptDirectory(env, key))
  }

  /** Who may remove `path`: a lane's claim means its owner only; an unreadable claim means no one. */
  const ownership = (path: string): Ownership => {
    const common = commonDir()
    if (common === null) return { owner: "unknown", reason: "the git common directory could not be resolved" }
    return ownershipOf(readClaim(common, path))
  }

  /** Landing records by receipt id; `unreadable` when any record could not be read. */
  const landings = (): { byReceipt: Map<string, LandingRecord>; unreadable: boolean; common: string | null } => {
    const common = commonDir()
    if (common === null) return { byReceipt: new Map(), unreadable: true, common }
    const listed = listLandings(common)
    return { byReceipt: new Map(listed.records.map((record) => [record.receiptId, record])), unreadable: listed.unreadable, common }
  }

  /** A short write to coordination state for `worktree`, under the same lock every remover takes. */
  const locked = <T>(worktree: string, write: () => T): Promise<T> => {
    const common = commonDir()
    if (common === null) return Promise.reject(new Error("the git common directory could not be resolved"))
    return lockedWrite(common, worktree, { sessionID: "delivery", now, ...deps.lock }, write)
  }

  /**
   * Update a landing record. The read, the decision and the write all happen inside the lock, from the
   * record as it is NOW: a writer queued behind another cannot overwrite what the first one wrote. An
   * existing denial survives every update; only an authorized re-arm (`clearDenial`) removes it.
   */
  const write = async (
    receiptId: string,
    worktree: string,
    update: (current: LandingRecord | undefined) => LandingRecord | undefined,
    options: { clearDenial?: boolean } = {},
  ) => {
    const common = commonDir()
    if (common === null) return
    await locked(worktree, () => {
      const read = readLanding(common, receiptId)
      if (read.kind === "unreadable") throw new Error(`the landing record ${receiptId} cannot be read`)
      const current = read.kind === "present" ? read.value : undefined
      let next = update(current)
      if (next !== undefined && current?.denied !== undefined && next.denied === undefined && options.clearDenial !== true) {
        next = { ...next, denied: current.denied }
      }
      if (next === undefined) removeLanding(common, receiptId)
      else writeLanding(common, next)
    })
  }

  /** Mark the beads reminder as sent. */
  const markNudged = (receiptId: string, worktree: string) =>
    write(receiptId, worktree, (current) => (current ? { ...current, nudged: true } : current))

  /**
   * Whether a record may be dropped, from the receipts as they are now: its own receipt is readable
   * and is cleaned or superseded by a readable later one.
   */
  const dropEvidence = (receiptId: string): boolean => {
    const directory = receiptsDirectory()
    return directory !== null && receiptSettled(directory, receiptId)
  }

  /** Delete a landing record under its worktree's lock, only if it is still not denied and the evidence still holds. */
  const dropLanding = async (common: string, record: { receiptId: string; worktree: string }, needsEvidence = true) =>
    locked(record.worktree, () => {
      const current = readLanding(common, record.receiptId)
      if (current.kind !== "present" || current.value.denied !== undefined) return
      if (needsEvidence && !dropEvidence(record.receiptId)) return
      removeLanding(common, record.receiptId)
    })

  /** `delivery_land` finished without removing the worktree: record the landing for whoever removes it. */
  const record = async (receipt: LandingReceipt, sessionID: string, outcome: { denied?: boolean } = {}) => {
    const path = receipt.worktree.path
    if (path === null) return
    // If the denial cannot be written to disk (the lock is busy, the store is unwritable), it is still
    // remembered here: the retry must never remove what was denied just because the record is missing.
    if (outcome.denied) deniedInMemory.set(receipt.receiptId, canonicalDirectory(path))
    await write(receipt.receiptId, path, (existing) => ({
      receiptId: receipt.receiptId,
      worktree: path,
      headRefOid: receipt.pr.headRefOid,
      sessionID,
      landedAt: existing?.landedAt ?? now(),
      ...(existing?.nudged ? { nudged: true } : {}),
      ...(outcome.denied ? { denied: { at: now(), sessionID } } : existing?.denied ? { denied: existing.denied } : {}),
    }))
  }

  /** This repository's pending receipts; throws when the directory cannot be listed, null without a key. */
  const pending = (): LandingReceipt[] | null => {
    const directory = receiptsDirectory()
    return directory === null ? null : pendingReceipts(listReceipts(directory))
  }

  /** Receipts, newest first, whose worktree is `path`. */
  const receiptsFor = (path: string): LandingReceipt[] => {
    const want = canonicalDirectory(path)
    return (pending() ?? []).filter((receipt) => receipt.worktree.path !== null && canonicalDirectory(receipt.worktree.path) === want)
  }

  /** An explicit `delivery_cleanup` for `worktree` was refused: that is a (new) denial, whatever came before. */
  const deny = async (worktree: string, sessionID: string) => {
    for (const receipt of receiptsFor(worktree)) await record(receipt, sessionID, { denied: true })
    // A record that exists without a pending receipt in view (for example after a restart) is denied too.
    for (const entry of landingsFor([...landings().byReceipt.values()], worktree)) {
      await write(entry.receiptId, entry.worktree, (current) => (current ? { ...current, denied: { at: now(), sessionID } } : current))
    }
  }

  /** An explicit `delivery_cleanup` for `worktree` was authorized: only now is an earlier denial cleared. */
  const arm = async (worktree: string) => {
    for (const [id, where] of deniedInMemory) if (where === canonicalDirectory(worktree)) deniedInMemory.delete(id)
    const { byReceipt } = landings()
    for (const entry of landingsFor([...byReceipt.values()], worktree)) {
      if (entry.denied === undefined) continue
      const { denied: _denied, ...rest } = entry
      await write(entry.receiptId, entry.worktree, () => rest, { clearDenial: true })
    }
  }

  /**
   * Whether `path` may be removed by delivery right now: no lane claims it (or can be read to
   * say so) and no session is running in it. Every page of the sessions is read; a lookup that
   * fails or is incomplete holds. Returns the reason to hold, or undefined.
   */
  const holdFor = async (path: string): Promise<string | undefined> => {
    const owned = ownershipDeferral(ownership(path))
    if (owned !== undefined) return owned
    if (holdsUnknown !== undefined) return holdsUnknown
    // Background work any idle gate (this plugin's or the lane owner's) recorded for this directory,
    // and whether the store those records live in can be written at all.
    const common = commonDir()
    if (common === null) return "the git common directory could not be resolved"
    const failed = unsafe.get(canonicalDirectory(path))
    if (failed !== undefined) return failed
    const running = holdsState(common, path, now())
    if (running !== undefined) return running
    try {
      let query: Record<string, unknown> = {
        ...(deps.projectID() === undefined ? {} : { project: deps.projectID() }),
        directory: path,
        archived: false,
        limit: 100,
      }
      for (let pages = 0; pages < MAX_SESSION_PAGES; pages++) {
        const page = (await ctx.session.list(query as never)) as { data?: unknown; cursor?: { next?: string } }
        if (!Array.isArray(page?.data)) return `the sessions in ${path} could not be listed`
        for (const raw of page.data as Array<{ time?: { busy?: unknown; idle?: unknown } }>) {
          const busy = typeof raw.time?.busy === "number" ? raw.time.busy : undefined
          const idle = typeof raw.time?.idle === "number" ? raw.time.idle : undefined
          if (busy !== undefined && (idle === undefined || busy > idle)) return `a session is running in ${path}`
        }
        const next = page.cursor?.next
        if (!next) return undefined
        query = { cursor: next }
      }
      return `the sessions in ${path} span more pages than are read`
    } catch {
      return `the sessions in ${path} could not be listed`
    }
  }

  /** A denial recorded for `path`, or records that cannot be read, read fresh. */
  const landingBlock = (path: string): string | undefined => {
    const common = commonDir()
    if (common === null) return "the git common directory could not be resolved"
    const listed = listLandings(common)
    if (listed.unreadable) return "the landing records could not be read"
    if ([...deniedInMemory.values()].includes(canonicalDirectory(path))) return "cleanup was denied; an explicit delivery_cleanup re-arms it"
    if (landingsFor(listed.records, path).some((entry) => entry.denied !== undefined)) {
      return "cleanup was denied; an explicit delivery_cleanup re-arms it"
    }
    return undefined
  }

  /**
   * The removal boundary every delivery remover goes through (explicit, inline, retry): the same
   * on-disk lock `subagent-worktree` takes, then, under it and after every proof, the last look at
   * claims, running work, sessions and denials, then the removal itself. Refuses (does not throw)
   * when anything holds.
   */
  const section = async (
    worktree: string,
    run: () => Promise<CleanupFailure | RemovalFacts>,
  ): Promise<CleanupFailure | RemovalFacts> => {
    const common = commonDir()
    if (common === null) return { ok: false, reason: "worktree.held: observed the git common directory could not be resolved, expected a coordination store; nothing was removed" }
    const outcome = await lockedWorktreeRemoval(common, worktree, { sessionID: "delivery", now, ...deps.lock }, {
      recheck: async () => (await holdFor(worktree)) ?? landingBlock(worktree),
      remove: run,
    })
    if (outcome.removed) return outcome.value
    return { ok: false, reason: `worktree.held: observed ${outcome.reason}, expected no owner, hold, denial or competing remover; nothing was removed` }
  }

  /**
   * Last step before the removal: move every idle session whose location is the worktree (or inside it)
   * to the repository's canonical checkout, so none is left pointing at a directory that is gone
   * ("Location not found"). A running session, a failed listing or a failed move refuses the removal.
   */
  const evict = async (worktree: string): Promise<string | undefined> => {
    const destination = canonicalCheckout(commonDir() ?? undefined, deps.root)
    const result = await evictSessions(ctx.session as unknown as SessionApi, { projectID: deps.projectID(), directory: worktree, destination })
    return result.ok ? undefined : result.reason
  }

  /** The last look before the removal call itself (claims, holds, sessions, denials), read fresh. */
  const finalCheck = async (worktree: string): Promise<string | undefined> =>
    (await holdFor(worktree)) ?? landingBlock(worktree) ?? (await evict(worktree))

  /**
   * Drop landing records, only on positive evidence: the record's own receipt is readable and is
   * cleaned or superseded by a readable later one. A denial is never dropped here (an authorized
   * re-arm clears it first). If the receipt directory is missing or unreadable, or the receipt
   * cannot be parsed, nothing is deleted. Returns whether the collection was complete: false when the
   * records could not all be read, so a caller keeps whatever it would otherwise forget.
   */
  const gc = async (): Promise<boolean> => {
    const recorded = landings()
    if (recorded.common === null || recorded.unreadable) return false
    for (const record of recorded.byReceipt.values()) {
      // A cheap look first; the decision is made again, under the lock, from the record and receipts as they are then.
      if (record.denied !== undefined || !dropEvidence(record.receiptId)) continue
      await dropLanding(recorded.common, record)
    }
    return true
  }

  /** The running work of this turn end could not be recorded: nothing is removed until a later turn end records it. */
  const setHoldsUnknown = (why: string) => {
    holdsUnknown = `its running work could not be recorded (${why})`
  }
  const clearHoldsUnknown = () => {
    holdsUnknown = undefined
  }

  /**
   * The idle hook's `background` list, written to disk for each of `receipts`' worktrees, so the
   * final check (and the lane owner) sees running work: a shell whose command names the worktree,
   * or any job of a session that works in it. A session with none clears its own entry.
   */
  const recordHolds = async (
    sessionID: string,
    background: ReadonlyArray<BackgroundJob>,
    receipts: readonly LandingReceipt[],
    locationOf: (sessionID: string) => Promise<string | undefined>,
  ) => {
    const common = commonDir()
    if (common === null) return
    for (const receipt of receipts) {
      const path = receipt.worktree.path
      if (path === null) continue
      const want = canonicalDirectory(path)
      const jobs: Array<{ kind: string; id: string }> = []
      for (const job of background) {
        let inside = job.kind === "shell" && typeof job.command === "string" && job.command.includes(path)
        for (const id of [job.sessionID, job.childSessionID]) {
          if (inside || typeof id !== "string") continue
          const where = await locationOf(id)
          if (where !== undefined && canonicalDirectory(where) === want) inside = true
        }
        if (inside) jobs.push({ kind: job.kind, id: job.shellID ?? job.childSessionID ?? job.sessionID ?? "unknown" })
      }
      try {
        await locked(path, () => setHold(common, path, sessionID, jobs, now()))
        unsafe.delete(want)
      } catch (error) {
        // The record could not be written, so running work cannot be ruled out: nothing is removed from this worktree until a write succeeds.
        const why = error instanceof Error ? error.message : String(error)
        unsafe.set(want, `its running work could not be recorded (${why})`)
        console.error(`delivery: could not record holds for ${path}: ${why}`)
      }
    }
  }

  /** Whether a receipt is denied here, on disk or in memory. */
  const deniedInView = (recorded: { byReceipt: Map<string, LandingRecord> }, receiptId: string): boolean =>
    recorded.byReceipt.get(receiptId)?.denied !== undefined || deniedInMemory.has(receiptId)

  return {
    commonDir,
    root: deps.root,
    receiptsDirectory,
    ownership,
    landings,
    markNudged,
    dropLanding,
    record,
    pending,
    deny,
    arm,
    holdFor,
    section,
    finalCheck,
    gc,
    recordHolds,
    setHoldsUnknown,
    clearHoldsUnknown,
    deniedInView,
  }
}

export type RepositoryCoordination = ReturnType<typeof repositoryCoordination>

export function createPendingCleanup(deps: PendingDeps) {
  const { ctx, cwd, env } = deps
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const limit = deps.maxPerPass ?? MAX_PER_PASS
  // The same ref-read bound `delivery_cleanup` uses (injectable through `cleanup.bounds`), not a fixed 5 s.
  const observationMs = deps.cleanup?.bounds?.refReadMs ?? CLEANUP_BOUNDS.refReadMs
  const doneIds = new Set<string>()
  const retriedAt = new Map<string, number>()
  const attemptedAt = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingIdle = new Set<string>()
  let disposed = false
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }

  const sessionProject = (ctx.location as { project?: { id?: string } }).project?.id
  /** The session repository's coordination. Its common directory and key are resolved on every use. */
  const session = repositoryCoordination({
    ctx,
    env,
    root: cwd,
    commonDir: () => repositoryContext(cwd, deps.observe, observationMs)?.commonDir ?? null,
    key: () => repoKey(cwd, deps.observe, observationMs),
    projectID: () => sessionProject,
    now,
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  })
  /**
   * The coordination of the repository a receipt landed in: found from the receipt's canonical
   * root, never assumed to be the session's. Undefined when that repository cannot be resolved.
   */
  const coordinationForReceipt = (receipt: LandingReceipt): RepositoryCoordination | undefined => {
    const target = repositoryContext(receipt.repo.canonicalRoot, deps.observe, observationMs)
    return target === null ? undefined : coordinationFor({ common: target.commonDir, root: target.ledger.root })
  }

  /** Who may remove the receipt's worktree, read from the repository it landed in; unknown if that cannot be resolved. */
  const ownershipFor = (receipt: LandingReceipt): Ownership => {
    const path = receipt.worktree.path
    if (path === null) return { owner: "none" }
    return (
      coordinationForReceipt(receipt)?.ownership(path) ?? {
        owner: "unknown",
        reason: `the repository ${receipt.repo.canonicalRoot} could not be resolved`,
      }
    )
  }

  /** `delivery_land` finished without removing the worktree: record the landing in the repository it landed in. */
  const record = async (receipt: LandingReceipt, sessionID: string, outcome: { denied?: boolean } = {}) => {
    const context = repositoryContext(receipt.repo.canonicalRoot, deps.observe, observationMs)
    if (context === null) throw new Error(`the repository ${receipt.repo.canonicalRoot} could not be resolved`)
    const target = coordinationFor({ common: context.commonDir, root: context.ledger.root })
    await target.record(receipt, sessionID, outcome)
    // A landing in another repository is retried from the session's registry; a denied one is never retried.
    const own = session.commonDir()
    if (outcome.denied || (own !== null && canonicalDirectory(own) === canonicalDirectory(context.commonDir))) return
    const entry: CloneEntry = {
      commonDir: context.commonDir,
      root: context.ledger.root,
      key: context.key,
      repo: receipt.repo.nameWithOwner,
      receiptIds: [receipt.receiptId],
      addedAt: now(),
    }
    await updateRegistry(cloneRegistryFile(env, sessionID), registryLock, (current) => withReceipts(current, entry)).catch((error) => {
      throw new Error(`the clone registry could not record the landing in ${entry.repo}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
  }
  const { ownership, deny, arm, markNudged, section } = session
  const registryLock = { now, ...deps.lock }

  /** The registered clones of a session, each with the coordination of its repository. Unresolvable or moved ones are left out. */
  const cloneTargets = (sessionID: string): Array<{ entry: CloneEntry; c: RepositoryCoordination }> => {
    const read = readRegistry(cloneRegistryFile(env, sessionID))
    if (read.kind === "unreadable") console.error(`delivery: the clone registry ${cloneRegistryFile(env, sessionID)} cannot be read`)
    if (read.kind !== "present") return []
    const own = session.commonDir()
    const targets: Array<{ entry: CloneEntry; c: RepositoryCoordination }> = []
    for (const entry of read.value.clones) {
      const context = repositoryContext(entry.root, deps.observe, observationMs)
      if (context === null || canonicalDirectory(context.commonDir) !== canonicalDirectory(entry.commonDir)) continue
      if (own !== null && canonicalDirectory(own) === canonicalDirectory(context.commonDir)) continue
      targets.push({ entry, c: coordinationFor({ common: context.commonDir, root: context.ledger.root }) })
    }
    return targets
  }

  const unregister = async (file: string, commonDir: string, ids: ReadonlySet<string>) => {
    if (ids.size === 0) return
    await updateRegistry(file, registryLock, (current) => withoutReceipts(current, commonDir, ids))
  }

  /**
   * Drop registrations whose receipt is cleaned or superseded (positive evidence only). The target
   * repository's landing records are collected first: once the registration is gone nothing else
   * would find them. A failure is reported and the registration stays for the next pass.
   */
  const gcClones = async () => {
    let files: string[]
    try {
      files = registryFiles(env)
    } catch (error) {
      console.error("delivery: clone registry gc failed", error)
      return
    }
    for (const file of files) {
      const read = readRegistry(file)
      if (read.kind === "unreadable") console.error(`delivery: the clone registry ${file} cannot be read`)
      if (read.kind !== "present") continue
      for (const entry of read.value.clones) {
        const settled = new Set(entry.receiptIds.filter((id) => receiptSettled(receiptDirectory(env, entry.key), id)))
        if (settled.size === 0) continue
        try {
          const collected = await coordinationFor({ common: entry.commonDir, root: entry.root }).gc()
          // Records that could not all be read stay for a later pass: the registration is what finds them.
          if (!collected) {
            console.error(`delivery: landing records of ${entry.repo} could not all be read; keeping its clone registration`)
            continue
          }
          await unregister(file, entry.commonDir, settled)
        } catch (error) {
          console.error(`delivery: clone registry gc failed for ${entry.repo}`, error)
        }
      }
    }
  }
  const gc = async () => {
    await session.gc()
    await gcClones()
  }

  /**
   * The coordination of the repository whose worktree is removed, chosen by the common directory
   * the identity proof read: the session's own, or one kept per foreign common directory so its
   * unsafe and denied sets survive between calls.
   */
  const foreign = new Map<string, RepositoryCoordination>()
  /** The host project of each other repository, once resolved from the sessions located in its checkout. */
  const foreignProjects = new Map<string, string>()
  const coordinationFor = (identity: CleanupIdentity): RepositoryCoordination => {
    const wanted = canonicalDirectory(identity.common)
    const own = session.commonDir()
    if (own !== null && canonicalDirectory(own) === wanted) return session
    let found = foreign.get(wanted)
    if (found === undefined) {
      found = repositoryCoordination({
        ctx,
        env,
        root: identity.root,
        commonDir: () => identity.common,
        key: () => repoKey(identity.root, deps.observe, observationMs),
        projectID: () => foreignProjects.get(wanted),
        now,
        ...(deps.lock === undefined ? {} : { lock: deps.lock }),
      })
      foreign.set(wanted, found)
    }
    return found
  }

  /**
   * The host project of another repository. The host's worktree registry is per project and the plugin
   * cannot ask which project a directory belongs to, so it is read from the sessions located in the
   * repository's checkout: exactly one project among them, else it is unresolved. Nothing here shows that
   * the host lists another project's sessions or worktrees from this session, so an unresolved project
   * is never guessed (the session's own is not the target's).
   */
  const resolveProject = async (identity: CleanupIdentity): Promise<string> => {
    const wanted = canonicalDirectory(identity.common)
    const known = foreignProjects.get(wanted)
    if (known !== undefined) return known
    const projects = new Set<string>()
    for (const archived of [false, true]) {
      let query: Record<string, unknown> = { directory: identity.root, archived, limit: 100 }
      for (let pages = 0; ; pages++) {
        if (pages >= MAX_SESSION_PAGES) throw new Error(`the sessions in ${identity.root} span more pages than are read`)
        const page = (await ctx.session.list(query as never)) as { data?: unknown; cursor?: { next?: string } }
        if (!Array.isArray(page?.data)) throw new Error(`the sessions in ${identity.root} could not be listed`)
        for (const raw of page.data as Array<{ projectID?: unknown }>) if (typeof raw?.projectID === "string") projects.add(raw.projectID)
        const next = page.cursor?.next
        if (!next) break
        query = { cursor: next }
      }
    }
    if (projects.size !== 1) {
      throw new Error(`the host project of ${identity.root} is ${projects.size === 0 ? "unknown (no session is located there)" : "ambiguous"}`)
    }
    const [only] = [...projects]
    foreignProjects.set(wanted, only as string)
    return only as string
  }

  /**
   * The host registry for another repository's worktree: its own project's, resolved when first used.
   * An unresolved project makes the list fail, which refuses the removal: a worktree the host registered
   * must go through the host, and without the project that cannot be known. Without a host registry at
   * all, git removes plain worktrees as before.
   */
  const foreignHost = (identity: CleanupIdentity): HostWorktrees | undefined => {
    const { hostIn, hostCapable } = deps
    if (hostIn === undefined || hostCapable?.() !== true) return undefined
    const registry = async () => {
      const host = hostIn(await resolveProject(identity))
      if (host === undefined) throw new Error("the host has no worktree registry")
      return host
    }
    return { list: async () => (await registry()).list(), remove: async (directory) => (await registry()).remove(directory) }
  }

  /** `coordinate` for a removal: the verified target's removal section and last look, plus the caller's prompt. */
  const coordinator =
    (authorize?: (c: RepositoryCoordination, request: { worktree: string; branch: string; pr: number }) => Promise<void>) =>
    async (identity: CleanupIdentity): Promise<CleanupCoordination> => {
      const c = coordinationFor(identity)
      const ownRepository = c === session
      if (!ownRepository) await resolveProject(identity).catch(() => {})
      return {
        ...(ownRepository ? {} : { host: foreignHost(identity) }),
        removalSection: c.section,
        finalCheck: c.finalCheck,
        ...(authorize === undefined ? {} : { authorize: (request) => authorize(c, request) }),
      }
    }

  /** The retry's `coordinate`: no prompt. */
  const removal = { coordinate: coordinator() }

  /** `coordinate` for an explicit `delivery_cleanup` call. */
  const explicit = (ask: (request: ExplicitRequest) => Promise<void>, sessionID: string) => ({
    coordinate: coordinator((c, request) => authorizeExplicit(c, ask, sessionID, request)),
  })

  /** `coordinate` for the cleanup `delivery_land` runs inline; `onDenied` fires when the prompt is refused. */
  const inline = (ask: (request: ExplicitRequest) => Promise<void>, onDenied: () => void) => ({
    coordinate: coordinator(async (_c, request) => {
      try {
        await ask(request)
      } catch (error) {
        onDenied()
        throw error
      }
    }),
  })

  /**
   * One pass over a repository's pending receipts for a finished turn of `sessionID`. For a
   * registered clone only its registered receipts are looked at; the result names the registered
   * ones that are finished (cleaned, superseded, gone or removed now).
   */
  const pass = async (c: RepositoryCoordination, sessionID: string, idle: boolean, clone?: CloneEntry): Promise<Set<string>> => {
    const finished = new Set<string>()
    // Settled by a cleaned or later receipt: finished only once the target's landing records are collected.
    const settled = new Set<string>()
    const directory = c.receiptsDirectory()
    if (directory === null) return finished
    let pending: LandingReceipt[]
    try {
      const all = c.pending() ?? []
      pending = clone === undefined ? all : all.filter((receipt) => clone.receiptIds.includes(receipt.receiptId))
      for (const id of clone?.receiptIds ?? []) if (!pending.some((receipt) => receipt.receiptId === id) && receiptSettled(directory, id)) settled.add(id)
    } catch {
      return finished
    }
    const recorded = c.landings()
    // Records that could not all be read stay for a later pass: the registration is what finds them.
    if (await c.gc()) for (const id of settled) finished.add(id)
    // A worktree that is gone is done, whatever the window holds.
    const present: LandingReceipt[] = []
    for (const receipt of pending) {
      if (receipt.worktree.path !== null && !existsSync(receipt.worktree.path)) {
        doneIds.add(receipt.receiptId)
        finished.add(receipt.receiptId)
        // Gone is evidence the worktree is done, but never erases a denial.
        if (recorded.common !== null && recorded.byReceipt.get(receipt.receiptId)?.denied === undefined) {
          await c.dropLanding(recorded.common, { receiptId: receipt.receiptId, worktree: receipt.worktree.path }, false)
        }
      } else if (!doneIds.has(receipt.receiptId)) present.push(receipt)
    }
    const window = selectWindow(present, {
      // Denied and lane-owned receipts need no attempt; they must not take a slot.
      skip: (receipt) =>
        c.deniedInView(recorded, receipt.receiptId) ||
        (receipt.worktree.path !== null && c.ownership(receipt.worktree.path).owner !== "none"),
      lastAttempt: (receipt) => attemptedAt.get(receipt.receiptId),
      limit,
    })
    for (const receipt of window) {
      if (disposed) return finished
      attemptedAt.set(receipt.receiptId, now())
      const path = resolve(directory, `${receipt.receiptId}.json`)
      const meta = recorded.byReceipt.get(receipt.receiptId)
      const recentlyTried = now() - (retriedAt.get(receipt.receiptId) ?? Number.NEGATIVE_INFINITY) < RETRY_WINDOW_MS
      const worktree = receipt.worktree.path as string
      const hold = await c.holdFor(worktree)
      const beads = hold !== undefined || recentlyTried ? "unknown" : await ledgerState(receipt, c.root, path, deps.cleanup?.run, undefined, observationMs, deps.observe)
      const decision = pendingCleanupAction(receipt, {
        worktreeGone: false,
        done: doneIds.has(receipt.receiptId),
        hold,
        beads,
        recentlyTried,
        landingSession: meta?.sessionID === sessionID,
        idle,
        nudged: meta?.nudged === true,
        denied: false,
      })
      if (decision.action === "nudge") {
        const sent = await ctx.session.synthetic({ sessionID, text: nudgeText(receipt, path, clone === undefined ? undefined : c.root) } as never).then(
          () => true,
          () => false,
        )
        if (sent && meta) await c.markNudged(receipt.receiptId, meta.worktree)
      } else if (decision.action === "retry") {
        retriedAt.set(receipt.receiptId, now())
        let result: CleanupResult
        try {
          // `guard` re-checks ownership after the proofs and before the removal.
          result = await cleanupDelivery(
            clone === undefined ? { receipt: path } : { receipt: path, repo: receipt.repo.nameWithOwner, repoPath: c.root },
            cwd,
            { env, host: deps.host(), ...removal, ...deps.cleanup },
          )
        } catch {
          continue
        }
        // A refusal is silent: the proofs say what is missing and a later turn end tries again.
        if (result.ok) {
          doneIds.add(receipt.receiptId)
          finished.add(receipt.receiptId)
          if (recorded.common !== null && recorded.byReceipt.get(receipt.receiptId)?.denied === undefined) {
            await c.dropLanding(recorded.common, { receiptId: receipt.receiptId, worktree }, false)
          }
        }
      }
    }
    return finished
  }

  /** The session repository's pass, then one per clone the session landed in. */
  const run = async (sessionID: string, idle: boolean) => {
    await pass(session, sessionID, idle)
    for (const { entry, c } of cloneTargets(sessionID)) {
      if (disposed) return
      await resolveProject({ common: entry.commonDir, root: entry.root }).catch(() => {})
      const finished = await pass(c, sessionID, idle, entry)
      await unregister(cloneRegistryFile(env, sessionID), entry.commonDir, finished).catch((error) => console.error("delivery: clone registry update failed", error))
    }
  }

  const retryNow = (sessionID: string, idle: boolean) =>
    disposed ? Promise.resolve() : serial(() => run(sessionID, idle)).catch((error) => console.error("delivery: pending cleanup failed", error))

  /** Debounced per session: `succeeded` and `idle` for one turn are one pass. */
  const schedule = (sessionID: string, idle: boolean) => {
    if (disposed) return
    if (idle) pendingIdle.add(sessionID)
    if (timers.has(sessionID)) return
    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID)
        void retryNow(sessionID, pendingIdle.delete(sessionID))
      }, debounceMs),
    )
  }

  const handleEvent = (raw: unknown) => {
    const event = raw as { type?: string; data?: { sessionID?: unknown } }
    const sessionID = event.data?.sessionID
    if (typeof sessionID !== "string") return
    if (event.type === "session.idle") schedule(sessionID, true)
    else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") schedule(sessionID, false)
  }

  /**
   * The idle hook's `background` list, written to disk for every worktree delivery might clean, so
   * its final check (and the lane owner) sees running work.
   */
  const recordHolds = async (sessionID: string, background: ReadonlyArray<BackgroundJob>) => {
    const locations = new Map<string, string | undefined>()
    const locationOf = async (id: string): Promise<string | undefined> => {
      if (!locations.has(id)) {
        const found = (await ctx.session.get({ sessionID: id } as never).catch(() => undefined)) as { location?: { directory?: string } } | undefined
        locations.set(id, found?.location?.directory)
      }
      return locations.get(id)
    }
    // Each repository on its own: a failure in one never skips another's holds. A repository whose
    // holds cannot be established refuses removal until a later turn end records them.
    const record = async (c: RepositoryCoordination, label: string, receipts: () => LandingReceipt[]) => {
      try {
        await c.recordHolds(sessionID, background, receipts(), locationOf)
        c.clearHoldsUnknown()
      } catch (error) {
        c.setHoldsUnknown(error instanceof Error ? error.message : String(error))
        console.error(`delivery: recording holds failed for ${label}`, error)
      }
    }
    await record(session, "the session repository", () => {
      if (session.commonDir() === null || session.receiptsDirectory() === null) throw new Error("the session repository could not be resolved")
      return (session.pending() ?? []).slice(0, 100)
    })
    for (const { entry, c } of cloneTargets(sessionID)) {
      await record(c, entry.repo, () => (c.pending() ?? []).filter((receipt) => entry.receiptIds.includes(receipt.receiptId)))
    }
  }

  const abort = new AbortController()
  const registrations: Array<{ dispose: () => Promise<void> }> = []
  let iterator: AsyncIterator<unknown> | undefined

  const start = async () => {
    iterator = ctx.event
      .subscribe({ types: ["session.execution.succeeded", "session.execution.failed", "session.idle"], signal: abort.signal } as never)
      [Symbol.asyncIterator]()
    const events = iterator
    void (async () => {
      for (;;) {
        const next = await events.next().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        try {
          handleEvent(next.value)
        } catch (error) {
          console.error("delivery: pending cleanup event failed", error)
        }
      }
    })()
    try {
      registrations.push(
        await ctx.session.hook(
          "experimental.idle" as never,
          (async (input: { sessionID: string; background?: ReadonlyArray<BackgroundJob> }) => {
            // Never throws out of the hook: coordination errors mean a held outcome, never a removal.
            try {
              await recordHolds(input.sessionID, input.background ?? [])
            } catch (error) {
              console.error("delivery: recording holds failed", error)
            }
            await retryNow(input.sessionID, true)
          }) as never,
        ),
      )
    } catch {
      // The hook is experimental; events cover its absence.
    }
  }

  const dispose = async () => {
    disposed = true
    abort.abort()
    await iterator?.return?.()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
    await chain
  }

  /** Wait for scheduled and running passes; for tests. */
  const settle = async () => {
    await new Promise((done) => setTimeout(done, 0)) // let a queued event reach the handler
    while (timers.size > 0) await new Promise((done) => setTimeout(done, debounceMs + 1))
    await chain
  }

  return { start, dispose, record, deny, arm, markNudged, ownership, ownershipFor, section, removal, explicit, inline, gc, retryNow, handleEvent, settle }
}
