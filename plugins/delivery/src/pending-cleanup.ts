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
  type CleanupDeps,
  type CleanupFailure,
  type CleanupResult,
  cleanupDelivery,
  type HostWorktrees,
  ledgerState,
  type RemovalFacts,
} from "./cleanup.ts"
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

/** The nudge text: which beads to close, with the commands. */
export function nudgeText(receipt: LandingReceipt, receiptPath: string): string {
  const sha = receipt.pr.mergeCommitOid ?? "missing"
  const commands = receipt.beads.ids.flatMap((id) => {
    const { update, close } = closeoutCommands(id, receipt.pr.number, sha, receiptPath)
    return [update, close]
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

export function createPendingCleanup(deps: PendingDeps) {
  const { ctx, cwd, env } = deps
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const limit = deps.maxPerPass ?? MAX_PER_PASS
  // The same ref-read bound `delivery_cleanup` uses (injectable through `cleanup.bounds`), not a fixed 5 s.
  const observationMs = deps.cleanup?.bounds?.refReadMs ?? CLEANUP_BOUNDS.refReadMs
  /** Worktrees whose hold could not be recorded: nothing is removed from them until a later write succeeds. */
  const unsafe = new Map<string, string>()
  /** Denials that could not be written to disk, until an authorized re-arm. */
  const deniedInMemory = new Map<string, string>()
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

  /** The repository's git common directory, where claims and landing records live; null if it cannot be resolved. */
  const commonDir = (): string | null => repositoryContext(cwd, deps.observe, observationMs)?.commonDir ?? null

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
    const key = repoKey(cwd, deps.observe, observationMs)
    if (key === null) return false
    const directory = resolve(receiptDirectory(env, key))
    try {
      const own = readReceipt(resolve(directory, `${receiptId}.json`))
      if (!own.ok) return false
      if (own.receipt.outcome === "cleaned" || own.receipt.worktree.removed) return true
      return listReceipts(directory).some((receipt) => receipt.supersedes === receiptId)
    } catch {
      return false
    }
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

  /** Receipts, newest first, whose worktree is `path`. */
  const receiptsFor = (path: string): LandingReceipt[] => {
    const key = repoKey(cwd, deps.observe, observationMs)
    if (key === null) return []
    const want = canonicalDirectory(path)
    return pendingReceipts(listReceipts(resolve(receiptDirectory(env, key)))).filter(
      (receipt) => receipt.worktree.path !== null && canonicalDirectory(receipt.worktree.path) === want,
    )
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
    // Background work any idle gate (this plugin's or the lane owner's) recorded for this directory,
    // and whether the store those records live in can be written at all.
    const common = commonDir()
    if (common === null) return "the git common directory could not be resolved"
    const failed = unsafe.get(canonicalDirectory(path))
    if (failed !== undefined) return failed
    const running = holdsState(common, path, now())
    if (running !== undefined) return running
    const projectID = (ctx.location as { project?: { id?: string } }).project?.id
    try {
      let query: Record<string, unknown> = {
        ...(projectID === undefined ? {} : { project: projectID }),
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

  /** The last look before the removal call itself (claims, holds, sessions, denials), read fresh. */
  const finalCheck = async (worktree: string): Promise<string | undefined> =>
    (await holdFor(worktree)) ?? landingBlock(worktree) ?? (await evict(worktree))

  /**
   * Last step before the removal: move every idle session whose location is the worktree (or inside it)
   * to the repository's canonical checkout, so none is left pointing at a directory that is gone
   * ("Location not found"). A running session, a failed listing or a failed move refuses the removal.
   */
  const evict = async (worktree: string): Promise<string | undefined> => {
    const projectID = (ctx.location as { project?: { id?: string } }).project?.id
    const destination = canonicalCheckout(commonDir() ?? undefined, cwd)
    const result = await evictSessions(ctx.session as unknown as SessionApi, { projectID, directory: worktree, destination })
    return result.ok ? undefined : result.reason
  }

  /** The removal dependencies every delivery remover passes to `cleanupDelivery`. */
  const removal = { removalSection: section, finalCheck }

  /** `authorize` and the removal dependencies for an explicit `delivery_cleanup` call. */
  const explicit = (ask: (request: ExplicitRequest) => Promise<void>, sessionID: string) => ({
    authorize: (request: ExplicitRequest) => authorizeExplicit(api, ask, sessionID, request),
    ...removal,
  })

  /**
   * Drop landing records, only on positive evidence: the record's own receipt is readable and is
   * cleaned or superseded by a readable later one. A denial is never dropped here (an authorized
   * re-arm clears it first). If the receipt directory is missing or unreadable, or the receipt
   * cannot be parsed, nothing is deleted.
   */
  const gc = async () => {
    const recorded = landings()
    if (recorded.common === null || recorded.unreadable) return
    for (const record of recorded.byReceipt.values()) {
      // A cheap look first; the decision is made again, under the lock, from the record and receipts as they are then.
      if (record.denied !== undefined || !dropEvidence(record.receiptId)) continue
      await dropLanding(recorded.common, record)
    }
  }

  /** One pass over this repository's pending receipts for a finished turn of `sessionID`. */
  const run = async (sessionID: string, idle: boolean) => {
    const key = repoKey(cwd, deps.observe, observationMs)
    if (key === null) return
    const directory = resolve(receiptDirectory(env, key))
    let pending: LandingReceipt[]
    try {
      pending = pendingReceipts(listReceipts(directory))
    } catch {
      return
    }
    const recorded = landings()
    await gc()
    // A worktree that is gone is done, whatever the window holds.
    const present: LandingReceipt[] = []
    for (const receipt of pending) {
      if (receipt.worktree.path !== null && !existsSync(receipt.worktree.path)) {
        doneIds.add(receipt.receiptId)
        // Gone is evidence the worktree is done, but never erases a denial.
        if (recorded.common !== null && recorded.byReceipt.get(receipt.receiptId)?.denied === undefined) {
          await dropLanding(recorded.common, { receiptId: receipt.receiptId, worktree: receipt.worktree.path }, false)
        }
      } else if (!doneIds.has(receipt.receiptId)) present.push(receipt)
    }
    const window = selectWindow(present, {
      // Denied and lane-owned receipts need no attempt; they must not take a slot.
      skip: (receipt) =>
        recorded.byReceipt.get(receipt.receiptId)?.denied !== undefined ||
        deniedInMemory.has(receipt.receiptId) ||
        (receipt.worktree.path !== null && ownership(receipt.worktree.path).owner !== "none"),
      lastAttempt: (receipt) => attemptedAt.get(receipt.receiptId),
      limit,
    })
    for (const receipt of window) {
      if (disposed) return
      attemptedAt.set(receipt.receiptId, now())
      const path = resolve(directory, `${receipt.receiptId}.json`)
      const meta = recorded.byReceipt.get(receipt.receiptId)
      const recentlyTried = now() - (retriedAt.get(receipt.receiptId) ?? Number.NEGATIVE_INFINITY) < RETRY_WINDOW_MS
      const worktree = receipt.worktree.path as string
      const hold = await holdFor(worktree)
      const beads = hold !== undefined || recentlyTried ? "unknown" : await ledgerState(receipt, cwd, path, deps.cleanup?.run)
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
        const sent = await ctx.session.synthetic({ sessionID, text: nudgeText(receipt, path) } as never).then(
          () => true,
          () => false,
        )
        if (sent && meta) await markNudged(receipt.receiptId, meta.worktree)
      } else if (decision.action === "retry") {
        retriedAt.set(receipt.receiptId, now())
        let result: CleanupResult
        try {
          // `guard` re-checks ownership after the proofs and before the removal.
          result = await cleanupDelivery({ receipt: path }, cwd, { env, host: deps.host(), ...removal, ...deps.cleanup })
        } catch {
          continue
        }
        // A refusal is silent: the proofs say what is missing and a later turn end tries again.
        if (result.ok) {
          doneIds.add(receipt.receiptId)
          if (recorded.common !== null && recorded.byReceipt.get(receipt.receiptId)?.denied === undefined) {
            await dropLanding(recorded.common, { receiptId: receipt.receiptId, worktree }, false)
          }
        }
      }
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
   * its final check (and the lane owner) sees running work: a shell whose command names the
   * worktree, or any job of a session that works in it. A session with none clears its own entry.
   */
  const recordHolds = async (sessionID: string, background: ReadonlyArray<BackgroundJob>) => {
    const common = commonDir()
    const key = repoKey(cwd, deps.observe, observationMs)
    if (common === null || key === null) return
    let pending: LandingReceipt[]
    try {
      pending = pendingReceipts(listReceipts(resolve(receiptDirectory(env, key)))).slice(0, 100)
    } catch {
      return
    }
    const locations = new Map<string, string | undefined>()
    const locationOf = async (id: string): Promise<string | undefined> => {
      if (!locations.has(id)) {
        const session = (await ctx.session.get({ sessionID: id } as never).catch(() => undefined)) as { location?: { directory?: string } } | undefined
        locations.set(id, session?.location?.directory)
      }
      return locations.get(id)
    }
    for (const receipt of pending) {
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

  const api = { deny, arm, ownership }

  return { start, dispose, record, deny, arm, markNudged, ownership, section, removal, explicit, gc, retryNow, handleEvent, settle }
}
