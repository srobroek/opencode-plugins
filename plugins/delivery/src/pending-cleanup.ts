/**
 * Cleanup that did not finish inside `delivery_land` is retried by delivery itself.
 *
 * With an active Beads ledger the beads close only after the land, so inline cleanup is
 * always skipped there; relying on the agent to call `delivery_cleanup` afterwards is the
 * original leak. A receipt whose worktree is still there is pending. Delivery retries it
 * when a session finishes a turn (`session.execution.*`, `session.idle`, and the
 * `experimental.idle` hook), with the same proofs `delivery_cleanup` applies, and nudges the
 * session that landed it once while its beads are still open.
 *
 * A worktree another plugin claimed at land time (the `cleanupHold` the input carried) is
 * left to that plugin until the claim expires: it removes the worktree under its own rules
 * and the receipt is then done. Delivery does not know who the claimant is.
 *
 * `pendingCleanupAction` is the pure decision; `createPendingCleanup` gathers the facts and
 * carries it out.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { CleanupHold } from "./auto-cleanup.ts"
import { type CleanupDeps, type CleanupResult, cleanupDelivery, type HostWorktrees, ledgerState } from "./cleanup.ts"
import {
  closeoutCommands,
  type LandingReceipt,
  listReceipts,
  receiptDirectory,
  repoKey,
} from "./landing-receipt.ts"

/** A claim by another plugin lapses after this, so a vanished claimant cannot strand a worktree. */
export const CLAIM_TTL_MS = 24 * 3_600_000
/** The same receipt is not tried twice within this window: an event and the idle hook fire for one turn end. */
export const RETRY_WINDOW_MS = 5_000
export const DEBOUNCE_MS = 2_000
const MAX_PER_PASS = 20

export type PendingAction = "retry" | "nudge" | "done" | "hold" | "skip"

export type PendingFacts = {
  /** The receipt's worktree is already gone, or a later receipt supersedes this one. */
  worktreeGone: boolean
  /** Cleanup already succeeded for this receipt in this process. */
  done: boolean
  /** Why a claimant or a running session keeps the worktree; undefined when nothing does. */
  hold: string | undefined
  /** `open`: a bead is not closed yet. `closed`: all are, or the ledger is inactive. */
  beads: "open" | "closed" | "unknown"
  /** Tried within {@link RETRY_WINDOW_MS}. */
  recentlyTried: boolean
  /** This turn end belongs to the session that ran `delivery_land`. */
  landingSession: boolean
  /** The trigger is an idle: the session has stopped. Nudges are sent only then. */
  idle: boolean
  /** The nudge for this receipt was already sent. */
  nudged: boolean
}

export function pendingCleanupAction(
  receipt: Pick<LandingReceipt, "worktree">,
  facts: PendingFacts,
): { action: PendingAction; reason: string } {
  if (facts.done) return { action: "skip", reason: "already cleaned" }
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

/** What delivery remembers about a landing, beyond the receipt. */
export type PendingMeta = {
  /** The session that ran `delivery_land`. */
  sessionID?: string
  /** Worktrees another plugin claimed, and when. */
  claims?: CleanupHold[]
  claimedAt?: number
  nudged?: boolean
}

const metaKey = (receiptId: string) => `delivery/pending/${receiptId}`

export type PendingDeps = {
  ctx: Context
  cwd: string
  env: NodeJS.ProcessEnv
  host: () => HostWorktrees | undefined
  canonical: (path: string) => string
  now?: () => number
  debounceMs?: number
  /** Test seam: the runner, bounds and clock the cleanup proofs use. */
  cleanup?: Pick<CleanupDeps, "run" | "bounds" | "now">
}

export function createPendingCleanup(deps: PendingDeps) {
  const { ctx, cwd, env } = deps
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const doneIds = new Set<string>()
  const triedAt = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingIdle = new Set<string>()
  let disposed = false
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }

  const readMeta = async (receiptId: string): Promise<PendingMeta> => {
    const value = await ctx.storage.get(metaKey(receiptId)).catch(() => undefined)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as PendingMeta) : {}
  }
  const writeMeta = (receiptId: string, meta: PendingMeta) => ctx.storage.set(metaKey(receiptId), meta as never)

  /** `delivery_land` finished without removing the worktree: remember who landed it and who claimed it. */
  const record = async (receipt: LandingReceipt, sessionID: string, claims: readonly CleanupHold[]) => {
    const path = receipt.worktree.path
    const mine = path === null ? [] : claims.filter((hold) => deps.canonical(hold.directory) === deps.canonical(path))
    await writeMeta(receipt.receiptId, {
      sessionID,
      ...(mine.length > 0 ? { claims: mine, claimedAt: now() } : {}),
    })
  }

  /** A claim is a hold only while it is fresh; a running session in the directory is a hold too. */
  const holdFor = async (receipt: LandingReceipt, meta: PendingMeta): Promise<string | undefined> => {
    if (meta.claims && meta.claims.length > 0 && meta.claimedAt !== undefined && now() - meta.claimedAt < CLAIM_TTL_MS) {
      return meta.claims[0]?.reason
    }
    const path = receipt.worktree.path
    const projectID = (ctx.location as { project?: { id?: string } }).project?.id
    if (path === null || projectID === undefined) return undefined
    try {
      const page = (await ctx.session.list({ project: projectID, directory: path, archived: false, limit: 100 } as never)) as { data?: unknown }
      for (const raw of Array.isArray(page.data) ? (page.data as Array<{ time?: { busy?: unknown; idle?: unknown } }>) : []) {
        const busy = typeof raw.time?.busy === "number" ? raw.time.busy : undefined
        const idle = typeof raw.time?.idle === "number" ? raw.time.idle : undefined
        if (busy !== undefined && (idle === undefined || busy > idle)) return `a session is running in ${path}`
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /** One pass over this repository's pending receipts for a finished turn of `sessionID`. */
  const run = async (sessionID: string, idle: boolean) => {
    const key = repoKey(cwd)
    if (key === null) return
    const directory = resolve(receiptDirectory(env, key))
    let pending: LandingReceipt[]
    try {
      pending = pendingReceipts(listReceipts(directory)).slice(0, MAX_PER_PASS)
    } catch {
      return
    }
    for (const receipt of pending) {
      if (disposed) return
      const path = resolve(directory, `${receipt.receiptId}.json`)
      const meta = await readMeta(receipt.receiptId)
      const recentlyTried = now() - (triedAt.get(receipt.receiptId) ?? Number.NEGATIVE_INFINITY) < RETRY_WINDOW_MS
      const worktreeGone = receipt.worktree.path !== null && !existsSync(receipt.worktree.path)
      const hold = worktreeGone ? undefined : await holdFor(receipt, meta)
      const beads = worktreeGone || hold !== undefined || recentlyTried ? "unknown" : await ledgerState(receipt, cwd, path, deps.cleanup?.run)
      const decision = pendingCleanupAction(receipt, {
        worktreeGone,
        done: doneIds.has(receipt.receiptId),
        hold,
        beads,
        recentlyTried,
        landingSession: meta.sessionID === sessionID,
        idle,
        nudged: meta.nudged === true,
      })
      if (decision.action === "done") {
        doneIds.add(receipt.receiptId)
        await ctx.storage.remove(metaKey(receipt.receiptId)).catch(() => {})
      } else if (decision.action === "nudge") {
        const sent = await ctx.session.synthetic({ sessionID, text: nudgeText(receipt, path) } as never).then(
          () => true,
          () => false,
        )
        if (sent) await writeMeta(receipt.receiptId, { ...meta, nudged: true })
      } else if (decision.action === "retry") {
        triedAt.set(receipt.receiptId, now())
        let result: CleanupResult
        try {
          result = await cleanupDelivery({ receipt: path }, cwd, { env, host: deps.host(), ...deps.cleanup })
        } catch {
          continue
        }
        // A refusal is silent: the proofs say what is missing and the next turn end tries again.
        if (result.ok) {
          doneIds.add(receipt.receiptId)
          await ctx.storage.remove(metaKey(receipt.receiptId)).catch(() => {})
        }
      }
    }
  }

  const retryNow = (sessionID: string, idle: boolean) =>
    disposed ? Promise.resolve() : serial(() => run(sessionID, idle)).catch((error) => console.error("delivery: pending cleanup failed", error))

  /** Debounced per session: `succeeded` and `idle` for one turn are one pass. */
  const schedule = (sessionID: string, idle: boolean) => {
    if (disposed) return
    const held = timers.get(sessionID)
    if (held !== undefined) {
      if (idle) pendingIdle.add(sessionID)
      return
    }
    if (idle) pendingIdle.add(sessionID)
    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID)
        const wasIdle = pendingIdle.delete(sessionID)
        void retryNow(sessionID, wasIdle)
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

  return { start, dispose, record, retryNow, handleEvent, settle }
}
