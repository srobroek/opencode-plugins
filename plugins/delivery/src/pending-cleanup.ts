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
import {
  canonicalDirectory,
  type LandingRecord,
  landingsFor,
  listLandings,
  type Ownership,
  ownershipOf,
  readClaim,
  removeLanding,
  writeLanding,
} from "@srobroek/opencode-lib/worktree-claims"
import { ownershipDeferral } from "./auto-cleanup.ts"
import { type CleanupDeps, type CleanupResult, cleanupDelivery, type HostWorktrees, ledgerState } from "./cleanup.ts"
import {
  closeoutCommands,
  type LandingReceipt,
  listReceipts,
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

/**
 * `authorize` for an explicit `delivery_cleanup` call. A refused call is a new denial, whatever
 * came before; an earlier denial is cleared only once this call is authorized.
 */
export async function authorizeExplicit(
  pending: { deny: (worktree: string, sessionID: string) => Promise<void>; arm: (worktree: string) => Promise<void> } | undefined,
  ask: (request: { worktree: string }) => Promise<void>,
  sessionID: string,
  request: { worktree: string },
): Promise<void> {
  try {
    await ask(request)
  } catch (error) {
    await pending?.deny(request.worktree, sessionID).catch(() => {})
    throw error
  }
  await pending?.arm(request.worktree).catch(() => {})
}

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
}

export function createPendingCleanup(deps: PendingDeps) {
  const { ctx, cwd, env } = deps
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const limit = deps.maxPerPass ?? MAX_PER_PASS
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
  const commonDir = (): string | null => repositoryContext(cwd)?.commonDir ?? null

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

  const write = (receiptId: string, update: (record: LandingRecord | undefined) => LandingRecord | undefined) => {
    const { byReceipt, common } = landings()
    if (common === null) return
    const next = update(byReceipt.get(receiptId))
    if (next === undefined) removeLanding(common, receiptId)
    else writeLanding(common, next)
  }

  /** `delivery_land` finished without removing the worktree: record the landing for whoever removes it. */
  const record = async (receipt: LandingReceipt, sessionID: string, outcome: { denied?: boolean } = {}) => {
    const path = receipt.worktree.path
    if (path === null) return
    write(receipt.receiptId, (existing) => ({
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
    const key = repoKey(cwd)
    if (key === null) return []
    const want = canonicalDirectory(path)
    return pendingReceipts(listReceipts(resolve(receiptDirectory(env, key)))).filter(
      (receipt) => receipt.worktree.path !== null && canonicalDirectory(receipt.worktree.path) === want,
    )
  }

  /** An explicit `delivery_cleanup` for `worktree` was refused: that is a (new) denial, whatever came before. */
  const deny = async (worktree: string, sessionID: string) => {
    for (const receipt of receiptsFor(worktree)) await record(receipt, sessionID, { denied: true })
  }

  /** An explicit `delivery_cleanup` for `worktree` was authorized: only now is an earlier denial cleared. */
  const arm = async (worktree: string) => {
    const { byReceipt } = landings()
    for (const entry of landingsFor([...byReceipt.values()], worktree)) {
      if (entry.denied === undefined) continue
      const { denied: _denied, ...rest } = entry
      write(entry.receiptId, () => rest)
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

  /** `authorize` for a removal delivery makes on its own: runs after every proof, right before the removal. */
  const guard = async (request: { worktree: string }) => {
    const hold = await holdFor(request.worktree)
    if (hold !== undefined) throw new Error(`held: ${hold}`)
  }

  /** One pass over this repository's pending receipts for a finished turn of `sessionID`. */
  const run = async (sessionID: string, idle: boolean) => {
    const key = repoKey(cwd)
    if (key === null) return
    const directory = resolve(receiptDirectory(env, key))
    let pending: LandingReceipt[]
    try {
      pending = pendingReceipts(listReceipts(directory))
    } catch {
      return
    }
    const recorded = landings()
    // Records of receipts that are no longer pending are stale: drop them.
    if (recorded.common !== null && !recorded.unreadable) {
      const live = new Set(pending.map((receipt) => receipt.receiptId))
      for (const id of recorded.byReceipt.keys()) if (!live.has(id)) removeLanding(recorded.common, id)
    }
    // A worktree that is gone is done, whatever the window holds.
    const present: LandingReceipt[] = []
    for (const receipt of pending) {
      if (receipt.worktree.path !== null && !existsSync(receipt.worktree.path)) {
        doneIds.add(receipt.receiptId)
        if (recorded.common !== null) removeLanding(recorded.common, receipt.receiptId)
      } else if (!doneIds.has(receipt.receiptId)) present.push(receipt)
    }
    const window = selectWindow(present, {
      // Denied and lane-owned receipts need no attempt; they must not take a slot.
      skip: (receipt) =>
        recorded.byReceipt.get(receipt.receiptId)?.denied !== undefined ||
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
        if (sent && meta) write(receipt.receiptId, (existing) => (existing ? { ...existing, nudged: true } : existing))
      } else if (decision.action === "retry") {
        retriedAt.set(receipt.receiptId, now())
        let result: CleanupResult
        try {
          // `guard` re-checks ownership after the proofs and before the removal.
          result = await cleanupDelivery({ receipt: path }, cwd, { env, host: deps.host(), authorize: guard, ...deps.cleanup })
        } catch {
          continue
        }
        // A refusal is silent: the proofs say what is missing and a later turn end tries again.
        if (result.ok) {
          doneIds.add(receipt.receiptId)
          if (recorded.common !== null) removeLanding(recorded.common, receipt.receiptId)
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
        await ctx.session.hook("experimental.idle" as never, ((input: { sessionID: string }) => retryNow(input.sessionID, true)) as never),
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

  return { start, dispose, record, deny, arm, ownership, guard, retryNow, handleEvent, settle }
}
