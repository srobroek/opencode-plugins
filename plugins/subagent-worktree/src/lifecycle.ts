/**
 * The lane lifecycle adapter: it gathers facts from git, `gh`, `wt` and the host, hands
 * them to the pure decisions in `events.ts`, `landing.ts` and `sweep.ts`, and carries out
 * the answer. Four layers share it, each covering what the others miss:
 *  - lane sync on a landing (`delivery_land` / `delivery_cleanup` results),
 *  - session execution events (failed, interrupted, succeeded, idle), debounced,
 *  - `experimental.idle` gates for a child and for a lead,
 *  - a throttled backstop sweep.
 * Every removal is a non-force host removal; nothing here deletes a remote branch.
 */

import { existsSync, realpathSync } from "node:fs"
import { stat, statfs } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { canonicalCheckout, evictSessions, repairStrandedSessions, type SessionApi } from "@srobroek/opencode-lib/session-eviction"
import { bumpClaim, claimGeneration, forgetNotice, landingsFor, listLandings, readClaim, readNotices, recordNotice } from "@srobroek/opencode-lib/worktree-claims"
import { holdsState, type LockOptions, lockedWorktreeRemoval, lockedWrite, setHold, withDiskLock } from "@srobroek/opencode-lib/worktree-locks"
import { OPERATION_MARKERS, operationsInProgress, stashesOnBranch } from "@srobroek/opencode-lib/worktree-state"
import { BUILD_GRACE_MS, type Detached, deleteDetached, detachBuildDirs, isLowDisk } from "./build-dirs.ts"
import {
  type BackgroundJob,
  childNudge,
  failureReason,
  gateMessage,
  idleGateAction,
  type LaneAction,
  type LaneEvent,
  type LaneFacts,
  type LanePolicy,
  landedDirtyNotice,
  laneBackgroundJobs,
  laneEventAction,
  noticeStillHolds,
  outcomeNotice,
  stateToken,
} from "./events.ts"
import type { Git } from "./git.ts"
import { LANDING_TOOLS, laneForLanding } from "./landing.ts"
import { isRunning, type Lane, type Options } from "./lane.ts"
import { formatPlan, type PlanEntry, planSweep, type WorktreeFacts } from "./sweep.ts"

/** Epoch milliseconds from a number, Date or date string; undefined otherwise. */
export function toMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const HOUR = 3_600_000
const PROOF_TTL_MS = 5 * 60_000
/** `--limit` of the batched pull request lists; a list this long may be cut off. */
const PR_LIST_LIMIT = 200
const EVENT_TYPES = [
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.succeeded",
  "session.idle",
  "session.created",
] as const
const PRIORITY: Record<string, number> = { idle: 0, succeeded: 1, interrupted: 2, failed: 3 }

type SessionLike = { id: string; parentID?: string; projectID: string; location: { directory: string }; time?: Record<string, unknown> }

export type LifecycleDeps = {
  ctx: Context
  options: Options
  git: Git
  now: () => number
  exists: (path: string) => Promise<boolean>
  lookupMs: number
  load: (child: string) => Promise<Lane | undefined>
  save: (lane: Lane) => Promise<unknown>
  scan: () => Promise<Lane[]>
  getSession: (sessionID: string) => Promise<SessionLike | undefined>
  moveHome: (lane: Lane) => Promise<void>
  removeWorktree: (projectID: string, directory: string, force: boolean) => Promise<void>
  /** Debounce for the event pass; the brief asks for about 2 s. */
  debounceMs?: number
  sweepDelayMs?: number
  worktreeRoot?: string
  /** The repository's git common directory, where claims and delivery's landing records live. */
  commonDir: (directory: string) => Promise<string | undefined>
  /** Make sure the lane's claim file exists (it is the lane's protection from every other remover). */
  ensureClaim: (lane: Lane) => Promise<void>
  /** Test seam for the on-disk lock (attempts, ttl, clock, liveness). */
  lock?: Partial<LockOptions>
  /** Test seam: how long ago a worktree was created. */
  age?: (directory: string) => Promise<number | undefined>
  /** Seams for freeing build directories; the host passes none. */
  build?: BuildSeams
}

export type BuildSeams = {
  /** Free bytes on the disk holding `path`; undefined when unknown. */
  freeBytes?: (path: string) => Promise<number | undefined>
  /** Runs after the sweep read a worktree's facts, before the lock for freeing its build directories is taken. */
  beforeLock?: (directory: string) => void | Promise<void>
  /** Deletes one detached build directory, after the lock is released. */
  deleteTrash?: (detached: Detached) => Promise<boolean>
}

const diskFreeBytes = async (path: string): Promise<number | undefined> => {
  try {
    const stats = await statfs(path)
    return stats.bavail * stats.bsize
  } catch {
    return undefined
  }
}

export const canonical = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function defaultWorktreeRoot(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "worktree")
}

/** Whether `path` is `root` or below it; trailing slashes on `root` are ignored. */
export function within(path: string, root: string): boolean {
  // Scan back from the end: an unanchored /\/+$/ retries at every slash and is quadratic in a long run of them.
  let end = root.length
  while (end > 0 && root.charCodeAt(end - 1) === 47) end--
  const base = root.slice(0, end)
  return path === base || path.startsWith(`${base}/`)
}

export function createLifecycle(deps: LifecycleDeps) {
  const { ctx, options, git, now, load, save } = deps
  const policy: LanePolicy = { resumeGraceMs: options.resumeGraceMs, emptyGraceMs: options.emptyGraceMs }
  const debounceMs = deps.debounceMs ?? 2000
  const root = canonical(deps.worktreeRoot ?? defaultWorktreeRoot())
  const projectID = (ctx.location as { project?: { id?: string } }).project?.id

  let disposed = false
  let gatesActive = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const pending = new Map<string, { type: string; reason?: string; id?: string; timer: ReturnType<typeof setTimeout> }>()
  const lastGate = new Map<string, number>()

  /** One chain for event passes, gates and sweeps' lane writes, so a lane is never handled twice at once. */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }
  let sweepChain: Promise<unknown> = Promise.resolve()

  // --- session status ---------------------------------------------------------------------

  const withinLookup = async <T>(work: Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), deps.lookupMs)
    })
    try {
      return await Promise.race([work.catch(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** running / finished from `session.get`; unknown when the lookup fails or times out. */
  const statusOf = async (sessionID: string): Promise<"running" | "finished" | "unknown"> => {
    const session = await withinLookup(deps.getSession(sessionID))
    if (!session) return "unknown"
    return isRunning({ busy: toMillis(session.time?.busy), idle: toMillis(session.time?.idle) }) ? "running" : "finished"
  }

  // --- landed proofs ------------------------------------------------------------------------

  type Proofs = {
    at: number
    merged: Set<string>
    open: Set<string>
    /** The open list was read and is shorter than its limit, so a branch missing from `open` has no open pull request. */
    openComplete: boolean
    closed: Set<string>
    integrated: Set<string>
  }
  const proofCache = new Map<string, Proofs>()

  /** One batched read per repository: merged PR heads, open PR branches, and `wt`'s integrated branches. Cached a few minutes. */
  const proofsFor = async (parentDir: string): Promise<Proofs> => {
    const cached = proofCache.get(parentDir)
    if (cached && now() - cached.at < PROOF_TTL_MS) return cached
    const proofs: Proofs = { at: now(), merged: new Set(), open: new Set(), openComplete: false, closed: new Set(), integrated: new Set() }
    const json = async (argv: string[]): Promise<unknown> => {
      const result = await git.run(argv, { cwd: parentDir })
      if (result.code !== 0) return undefined
      try {
        return JSON.parse(result.stdout)
      } catch {
        return undefined
      }
    }
    const [merged, open, closed, listed] = await Promise.all([
      json(["gh", "pr", "list", "--state", "merged", "--json", "headRefOid", "--limit", "200"]),
      json(["gh", "pr", "list", "--state", "open", "--json", "headRefName", "--limit", String(PR_LIST_LIMIT)]),
      // gh's "closed" state is closed without merging; merged pull requests are listed above.
      json(["gh", "pr", "list", "--state", "closed", "--json", "headRefOid", "--limit", "200"]),
      json(["wt", "-C", parentDir, "list", "--format", "json"]),
    ])
    for (const pr of Array.isArray(merged) ? merged : []) {
      const oid = (pr as { headRefOid?: unknown }).headRefOid
      if (typeof oid === "string") proofs.merged.add(oid)
    }
    for (const pr of Array.isArray(closed) ? closed : []) {
      const oid = (pr as { headRefOid?: unknown }).headRefOid
      if (typeof oid === "string") proofs.closed.add(oid)
    }
    proofs.openComplete = Array.isArray(open) && open.length < PR_LIST_LIMIT
    for (const pr of Array.isArray(open) ? open : []) {
      const name = (pr as { headRefName?: unknown }).headRefName
      if (typeof name === "string") proofs.open.add(name)
    }
    const items = (listed as { items?: unknown } | undefined)?.items
    for (const item of Array.isArray(items) ? items : []) {
      // Keyed by commit, never by branch name: a branch that gained a commit since is not integrated.
      const entry = item as { head?: { sha?: unknown }; display?: { state?: unknown } }
      if (typeof entry.head?.sha === "string" && entry.display?.state === "integrated") proofs.integrated.add(entry.head.sha)
    }
    proofCache.set(parentDir, proofs)
    return proofs
  }

  /** The tree holds something git status does not show: a stash on the branch or an operation in progress. */
  const busyTreeOf = async (directory: string, branch: string | undefined): Promise<string | undefined> => {
    const dir = await git.gitDir(directory)
    if (dir !== undefined) {
      const operations = operationsInProgress(OPERATION_MARKERS.map((marker) => marker.name).filter((name) => existsSync(join(dir, name))))
      if (operations.length > 0) return `a ${operations.join(", ")} is in progress`
    }
    if (branch !== undefined) {
      const stash = await git.stashSubjects(directory)
      if (stash === undefined) return "stashes could not be read"
      if (stashesOnBranch(stash, branch).length > 0) return `a stash exists on ${branch}`
    }
    return undefined
  }

  /** What delivery's landing records say about `directory`: the heads it landed, and why it must not be removed, if so. */
  const deliveryRecords = async (directory: string, parentDir: string): Promise<{ heads: string[]; block: string | undefined }> => {
    const common = await deps.commonDir(parentDir)
    if (common === undefined) return { heads: [], block: "delivery's records cannot be located" }
    const listed = listLandings(common)
    const mine = landingsFor(listed.records, directory)
    const heads = mine.map((record) => record.headRefOid)
    if (listed.unreadable) return { heads, block: "delivery's landing records cannot be read" }
    const denied = mine.find((record) => record.denied !== undefined)
    return { heads, block: denied ? "delivery cleanup was denied; an explicit delivery_cleanup re-arms it" : undefined }
  }

  /**
   * Worktrees whose running work could not be recorded: kept across passes (not per invocation) until a
   * later hold write for them succeeds. Nothing is removed from them meanwhile.
   */
  const unsafeHolds = new Map<string, string>()

  /** Why background work (from any session's idle gate) blocks removing `directory`; read fresh from disk. */
  const holdReason = async (directory: string, parentDir: string): Promise<string | undefined> => {
    const failed = unsafeHolds.get(canonical(directory))
    if (failed !== undefined) return failed
    const common = await deps.commonDir(parentDir)
    if (common === undefined) return "the background-work records cannot be located"
    return holdsState(common, directory, now())
  }

  const dirtyToken = (porcelain: string): string => (porcelain === "" ? "clean" : String(Bun.hash(porcelain)))

  /**
   * The tip reached the base branch through work of this lane: it is an ancestor of `origin/main` and was
   * not already reachable from main when the lane was created. A lane without that record (or whose tip was
   * already in main) has no work of its own, so it is empty, never landed: it fails closed.
   */
  const reachedMain = async (lane: Lane, tip: string): Promise<boolean> => {
    if (lane.mainAtCreation === undefined) return false
    if (!(await git.isAncestor(lane.directory, tip, "origin/main"))) return false
    return !(await git.isAncestor(lane.directory, tip, lane.mainAtCreation))
  }

  const laneFacts = async (
    lane: Lane,
    sessions: { child: LaneFacts["child"]; parent: LaneFacts["parent"] },
  ): Promise<LaneFacts> => {
    const base = { child: sessions.child, parent: sessions.parent, now: now() }
    if (!(await deps.exists(lane.directory))) {
      return { ...base, exists: false, ahead: undefined, dirty: undefined, dirtyToken: "gone", busyTree: undefined, tip: undefined, landed: false, openPr: false, denied: undefined }
    }
    const [status, porcelain, tip] = await Promise.all([git.status(lane.directory, lane.base), git.porcelain(lane.directory), git.head(lane.directory)])
    const busyTree = status === undefined ? undefined : await busyTreeOf(lane.directory, lane.branch)
    const records = await deliveryRecords(lane.directory, lane.parentDir)
    let landed = false
    let openPr = false
    if (status !== undefined && tip !== undefined && status.ahead > 0) {
      // A head delivery recorded as landed counts only for the commit that is still the tip.
      landed = records.heads.includes(tip) || (await reachedMain(lane, tip))
      if (!landed) {
        const proofs = await proofsFor(lane.parentDir)
        landed = proofs.merged.has(tip) || proofs.integrated.has(tip)
        openPr = proofs.open.has(lane.branch)
      }
    }
    return {
      ...base,
      exists: true,
      ahead: status?.ahead,
      dirty: porcelain === undefined ? undefined : porcelain !== "",
      dirtyToken: dirtyToken(porcelain ?? ""),
      busyTree,
      tip,
      landed,
      openPr,
      denied: records.block,
    }
  }

  // --- one fence for every removal ----------------------------------------------------------

  /**
   * The resume generation, read from the lane's claim on disk (plugins load once per location, so a
   * resume by another instance has to be visible here). -1 when there is no readable claim.
   */
  const generationOf = async (directory: string, parentDir: string): Promise<number> => {
    const common = await deps.commonDir(parentDir)
    return common === undefined ? -1 : claimGeneration(readClaim(common, directory))
  }

  const localLocks = new Map<string, Promise<unknown>>()

  /**
   * One at a time per directory, across every plugin instance of the repository: an in-process queue
   * first (cheap, fair), then the on-disk lock. A lock that cannot be taken rejects.
   */
  const withLock = async <T>(directory: string, parentDir: string, work: () => Promise<T>): Promise<T> => {
    const key = canonical(directory)
    const common = await deps.commonDir(parentDir)
    if (common === undefined) throw new Error(`subagent-worktree: no git common directory to lock ${directory}`)
    return queueLocally(key, () => withDiskLock(common, directory, { sessionID: "subagent-worktree", now, ...deps.lock }, work))
  }

  /** In-process queue per directory, in front of the disk lock. */
  const queueLocally = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (localLocks.get(key) ?? Promise.resolve()).then(run, run)
    localLocks.set(key, next.catch(() => {}))
    return next
  }

  /**
   * A `subagent` call is about to resume the child of this lane: waits for a removal in flight (in
   * any instance), then bumps the generation on disk and records when, so later removals abort.
   */
  const noteResume = (directory: string, parentDir: string) =>
    withLock(directory, parentDir, async () => {
      const common = await deps.commonDir(parentDir)
      if (common !== undefined) bumpClaim(common, directory, now())
    })

  type Removal = {
    directory: string
    projectID: string
    branch: string | undefined
    parentDir: string
    /** The generation read before the facts were collected. */
    gen: number
    /** `empty`: HEAD is the commit the lane started from. `landed`: `isLanded(HEAD)`. */
    basis: "landed" | "empty"
    /** The commit an empty lane started from. */
    base?: string
    /** Whether a commit is landed; evaluated against the one HEAD captured under the lock. */
    isLanded: (oid: string) => Promise<boolean>
    /** The lane whose child is moved home first, and whose record is retired inside the same critical section. */
    lane?: Lane
    /** Run under the lock, right before the removal: the refusal to honour, if any. */
    recheck?: () => Promise<string | undefined>
  }

  /**
   * The only removal path, one critical section against one snapshot. Under the directory lock:
   * the resume generation is unchanged; HEAD is read once, and every proof (empty, or landed),
   * the clean tree and the branch ref are evaluated against that one commit; fresh re-reads of
   * ownership, records and liveness agree; then the worktree is removed, the branch deleted with a
   * compare-and-delete on that commit, and the lane retired with its claim, all before the lock is
   * released, so a resume that was waiting sees the finished state and revives from it.
   */
  const removeVerified = async (removal: Removal): Promise<boolean> => {
    const { directory, branch } = removal
    try {
      const common = await deps.commonDir(removal.parentDir)
      if (common === undefined) return false
      // Captured once under the lock and used by every proof and by the compare-and-delete.
      let oid: string | undefined
      let deleteBranch = false
      const outcome = await queueLocally(canonical(directory), () =>
        lockedWorktreeRemoval(common, directory, { sessionID: "subagent-worktree", now, ...deps.lock }, {
          recheck: async () => {
            // Re-read from disk under the lock: a resume by any instance bumps the generation and stamps resumedAt.
            const claim = readClaim(common, directory)
            if (claimGeneration(claim) !== removal.gen) return "the lane was resumed"
            if (claim.kind === "present" && claim.value.resumedAt !== undefined && now() - claim.value.resumedAt < options.resumeGraceMs) {
              return "the lane was resumed recently"
            }
            const failedWrite = unsafeHolds.get(canonical(directory))
            if (failedWrite !== undefined) return failedWrite
            const running = holdsState(common, directory, now())
            if (running !== undefined) return running
            oid = await git.head(directory)
            if (oid === undefined) return "HEAD cannot be read"
            if ((await git.porcelain(directory)) !== "") return "the tree is not clean"
            if ((await busyTreeOf(directory, branch)) !== undefined) return "a stash or an operation is in progress"
            const proven = removal.basis === "empty" ? oid === removal.base : await removal.isLanded(oid)
            if (!proven) return "HEAD is not the commit the proof covers"
            if (branch !== undefined && (await git.branch(directory)) === branch) {
              // On the branch: the ref must be the commit captured above, or something moved it.
              if ((await git.commit(removal.parentDir, `refs/heads/${branch}`)) !== oid) return "the branch moved"
              deleteBranch = true
            }
            return undefined
          },
          remove: async () => {
            // The last look at liveness: resume generation and window, running work, delivery's records, the
            // child's and parent's status. It comes after every ref read and the move home, immediately
            // before the host removal call, so nothing that changed during those reads can slip past it.
            const finalRefusal = async (): Promise<string | undefined> => {
              const claim = readClaim(common, directory)
              if (claimGeneration(claim) !== removal.gen) return "the lane was resumed"
              if (claim.kind === "present" && claim.value.resumedAt !== undefined && now() - claim.value.resumedAt < options.resumeGraceMs) {
                return "the lane was resumed recently"
              }
              const failedWrite = unsafeHolds.get(canonical(directory))
              if (failedWrite !== undefined) return failedWrite
              const running = holdsState(common, directory, now())
              if (running !== undefined) return running
              return removal.recheck?.()
            }
            try {
              if (removal.lane) await deps.moveHome(removal.lane)
              if ((await finalRefusal()) !== undefined) {
                if (removal.lane && (await deps.exists(directory))) {
                  await ctx.session.move({ sessionID: removal.lane.child, directory } as never).catch(() => {})
                }
                return false
              }
              // Last, so nothing that refused above has moved anyone: every other idle session in the worktree
              // goes to the checkout, or the removal is refused (a running one, a failed lookup or move).
              const evicted = await evictSessions(ctx.session as unknown as SessionApi, {
                projectID: removal.projectID,
                directory,
                destination: canonicalCheckout(common, removal.parentDir),
                ...(removal.lane ? { exclude: new Set([removal.lane.child]) } : {}),
              })
              if (!evicted.ok) {
                console.error(`subagent-worktree: not removing ${directory}: ${evicted.reason}`)
                if (removal.lane && (await deps.exists(directory))) {
                  await ctx.session.move({ sessionID: removal.lane.child, directory } as never).catch(() => {})
                }
                return false
              }
              await deps.removeWorktree(removal.projectID, directory, false)
            } catch {
              if (removal.lane && (await deps.exists(directory))) {
                await ctx.session.move({ sessionID: removal.lane.child, directory } as never).catch(() => {})
              }
              return false
            }
            await ctx.worktree.refresh({ projectID: removal.projectID } as never).catch(() => {})
            if (deleteBranch && branch !== undefined && oid !== undefined) await git.deleteBranchAt(removal.parentDir, branch, oid)
            if (removal.lane) {
              // Retire only the record this removal is about: same directory, still active, same generation.
              const stored = await load(removal.lane.child)
              if (stored?.state === "active" && canonical(stored.directory) === canonical(directory) && claimGeneration(readClaim(common, directory)) === removal.gen) {
                await save({ ...stored, state: removal.basis === "empty" ? "removed" : "landed" })
              }
            }
            return true
          },
        }),
      )
      return outcome.removed && outcome.value
    } catch (error) {
      // A coordination or bookkeeping error is a held outcome: logged, never thrown out of a hook, never a reason to remove.
      console.error(`subagent-worktree: removal of ${directory} deferred:`, error instanceof Error ? error.message : error)
      return false
    }
  }

  /** Whether `oid` is landed: delivery recorded it, it is an ancestor of origin/main, or a merged PR / `wt` says so. Read fresh. */
  const landedProof = (directory: string, parentDir: string, lane?: Lane) => async (oid: string): Promise<boolean> => {
    const records = await deliveryRecords(directory, parentDir)
    if (records.heads.includes(oid)) return true
    // A lane's own work must have reached main; a worktree that is not a lane only needs its tip in main.
    if (lane ? await reachedMain(lane, oid) : await git.isAncestor(directory, oid, "origin/main")) return true
    const proofs = await proofsFor(parentDir)
    return proofs.merged.has(oid) || proofs.integrated.has(oid)
  }

  /** True only when a fresh, successful lookup finds no open pull request from `branch`; any failure is false. */
  const noOpenPrFrom = async (branch: string, parentDir: string): Promise<boolean> => {
    const result = await git.run(["gh", "pr", "list", "--state", "open", "--head", branch, "--json", "number", "--limit", "1"], { cwd: parentDir })
    if (result.code !== 0) return false
    try {
      const list: unknown = JSON.parse(result.stdout)
      return Array.isArray(list) && list.length === 0
    } catch {
      return false
    }
  }

  /**
   * Whether `oid` heads a pull request closed without merging and a fresh lookup proves none is open from
   * `branch` now; or is landed. Never trusts the cached open list. The ref is never deleted.
   */
  const closedProof = (directory: string, branch: string | undefined, parentDir: string, lane?: Lane) => async (oid: string): Promise<boolean> => {
    if (await landedProof(directory, parentDir, lane)(oid)) return true
    if (branch === undefined || !(await proofsFor(parentDir)).closed.has(oid)) return false
    return noOpenPrFrom(branch, parentDir)
  }

  // --- actions ------------------------------------------------------------------------------

  const mark = async (child: string, key: string) => {
    const lane = await load(child)
    if (!lane) return
    await save({ ...lane, notices: [...(lane.notices ?? []), key].slice(-20) })
  }

  /**
   * Claim the right to send one notice, across every plugin instance of the repository. Under the lane's
   * lock it checks that the lane is still active with its claim (a retired lane gets no notices), that the
   * key was not sent, and that the state the notice describes still holds when read fresh; a worktree that
   * is gone is repaired instead. Only then is the key recorded on disk, next to the claim.
   */
  const reserve = async (lane: Lane, key: string): Promise<"ok" | "skip"> => {
    try {
      return await withLock(lane.directory, lane.parentDir, async () => {
        const common = await deps.commonDir(lane.parentDir)
        if (common === undefined) return "skip"
        // First give back what an earlier failed send left reserved, in the same critical section.
        releaseHeld(common, lane)
        const claim = readClaim(common, lane.directory)
        const stored = await load(lane.child)
        if (claim.kind !== "present" || claim.value.sessionID !== lane.child || stored?.state !== "active") return "skip"
        const sent = readNotices(common, lane.directory)
        if (sent.kind !== "present" || sent.value.includes(key)) return "skip"
        // A child's own nudge and a failure are about a child that just stopped; the others need it known to be finished.
        const stopped = key.startsWith("child:dirty:") || key.startsWith("parent:")
        const facts = await laneFacts(stored, { child: stopped ? "finished" : await statusOf(lane.child), parent: "unknown" })
        if (!facts.exists) {
          await deps.moveHome(stored)
          await save({ ...stored, state: "removed" })
          return "skip"
        }
        if (!noticeStillHolds(key, facts)) return "skip"
        recordNotice(common, lane.directory, key)
        return "ok"
      })
    } catch (error) {
      console.error(`subagent-worktree: notice for ${lane.directory} not sent:`, error instanceof Error ? error.message : error)
      return "skip"
    }
  }

  /**
   * Keys reserved on disk whose message was not delivered and that are not given back yet, by lane directory.
   * An entry leaves only once its keys are forgotten on disk: every later reservation for the lane retries
   * first, and shutdown makes a last attempt. It lives in memory, so a crash before the release succeeds
   * leaves that one notice (same lane, head and dirty state) suppressed until the lane changes or is retired.
   */
  const unreleased = new Map<string, { lane: Lane; keys: Set<string> }>()

  /** Forget the lane's undelivered keys on disk. The caller holds the lane's lock; a failed write throws. */
  const releaseHeld = (common: string, lane: Lane) => {
    const id = canonical(lane.directory)
    const entry = unreleased.get(id)
    if (entry === undefined) return
    for (const key of [...entry.keys]) if (forgetNotice(common, lane.directory, key)) entry.keys.delete(key)
    if (entry.keys.size === 0) unreleased.delete(id)
  }

  /** Try to give back the lane's undelivered keys now; what cannot be released stays queued for a retry. */
  const flushReleases = async (lane: Lane) => {
    try {
      await withLock(lane.directory, lane.parentDir, async () => {
        const common = await deps.commonDir(lane.parentDir)
        if (common === undefined) throw new Error("no git common directory")
        releaseHeld(common, lane)
      })
    } catch (error) {
      console.error(`subagent-worktree: notice reservation for ${lane.directory} not released yet:`, error instanceof Error ? error.message : error)
    }
  }

  /** Give reserved keys back when their message could not be delivered, so a later pass sends it. */
  const release = async (lane: Lane, keys: readonly string[]) => {
    const id = canonical(lane.directory)
    const entry = unreleased.get(id) ?? { lane, keys: new Set<string>() }
    for (const key of keys) entry.keys.add(key)
    unreleased.set(id, entry)
    await flushReleases(lane)
  }

  /** One notice, sent once: reserved on disk, then delivered; recorded on the lane too. */
  const deliver = async (lane: Lane, key: string, sessionID: string, text: string) => {
    if ((await reserve(lane, key)) !== "ok") return
    if (await send(sessionID, text)) await mark(lane.child, key)
    else await release(lane, [key])
  }

  const send = async (sessionID: string, text: string): Promise<boolean> => {
    try {
      await ctx.session.synthetic({ sessionID, text } as never)
      return true
    } catch {
      return false
    }
  }

  /**
   * What must still be true at the moment of removal, read fresh under the lock: delivery has not
   * denied or hidden its records, the idle gate has not found work running, the child is finished
   * and the parent idle now. `parentIdle` is true only when the idle hook itself is the evidence.
   */
  const recheckFor =
    (lane: Lane | undefined, directory: string, parentDir: string, parentIdle: boolean, owner?: { minAgeMs: number }) =>
    async (): Promise<string | undefined> => {
      // Every sweep candidate, lane or not: nobody may be working in it now (all pages read, fail closed).
      if (owner !== undefined && (await ownerOf(directory, owner.minAgeMs)) !== "no") return "its ownership could not be confirmed"
      const records = await deliveryRecords(directory, parentDir)
      if (records.block !== undefined) return records.block
      if (lane === undefined) return undefined
      if ((await statusOf(lane.child)) !== "finished") return "the child is not finished now"
      if (!parentIdle && (await statusOf(lane.parent)) !== "finished") return "the parent is not idle now"
      return undefined
    }

  /** A lane's removal, fenced by the generation read before its facts were collected. */
  const removeLane = async (lane: Lane, basis: "landed" | "empty", gen: number, parentIdle = false): Promise<boolean> =>
    removeVerified({
      directory: lane.directory,
      projectID: lane.projectID,
      branch: lane.branch,
      parentDir: lane.parentDir,
      gen,
      basis,
      base: lane.base,
      isLanded: landedProof(lane.directory, lane.parentDir, lane),
      lane,
      recheck: recheckFor(lane, lane.directory, lane.parentDir, parentIdle),
    })

  /**
   * The empty lane of a foreground `subagent` call that just returned. Same path as every other
   * removal; the caller is blocked on this very call, so the returned result is the evidence that
   * the parent is not mid-turn elsewhere. `gen` is read before the lane's status was.
   */
  const removeForeground = (lane: Lane, gen: number): Promise<boolean> => removeLane(lane, "empty", gen, true)

  const act = async (lane: Lane, action: LaneAction, facts: LaneFacts, event: LaneEvent, gen: number) => {
    if (action.action === "remove") return removeLane(lane, action.basis, gen)
    if (action.action === "defer" && action.quiet) {
      const quietSince = action.quiet === "start" ? facts.now : undefined
      if (lane.quietSince !== quietSince) await save({ ...((await load(lane.child)) ?? lane), ...(quietSince === undefined ? { quietSince: undefined } : { quietSince }) })
      return
    }
    if (action.action === "notifyParent") {
      const text = action.key.startsWith("landed-dirty")
        ? landedDirtyNotice(lane)
        : outcomeNotice(lane, lane.outcome?.kind ?? (event.type === "interrupted" ? "interrupted" : "failed"), lane.outcome?.reason ?? "no reason given", facts)
      await deliver(lane, action.key, lane.parent, text)
      return
    }
    if (action.action === "notifyChild") {
      // With the idle gate registered it owns this nudge (one source); keys keep either path from repeating.
      if (gatesActive && event.type !== "idle") return
      await deliver(lane, action.key, lane.child, childNudge(lane))
    }
  }

  // --- execution events ---------------------------------------------------------------------

  const TERMINAL = new Set(["succeeded", "idle", "failed", "interrupted"])

  const pass = async (sessionID: string, type: string, reason: string | undefined, eventID: string | undefined) => {
    const lanes = await deps.scan()
    const own = lanes.find((lane) => lane.child === sessionID && lane.state === "active")
    const led = lanes.filter((lane) => lane.parent === sessionID && lane.child !== sessionID && lane.state === "active")
    if (own === undefined && led.length === 0) return
    for (const lane of [...(own ? [own] : []), ...led]) await deps.ensureClaim(lane)
    const eventType = type as LaneEvent["type"]
    let ownLane = own
    if (ownLane && (type === "failed" || type === "interrupted")) {
      const why = reason ?? "no reason given"
      // Identity of the outcome, never its time: a replayed event keeps its key, a new failure gets a new one.
      const id = eventID ?? `h${Bun.hash(`${sessionID}:${type}:${why}`)}`
      ownLane = { ...ownLane, outcome: { kind: type, at: now(), reason: why, id }, quietSince: undefined }
      await save(ownLane)
    }
    if (ownLane) {
      const event: LaneEvent = { type: eventType, subject: "child" }
      const gen = await generationOf(ownLane.directory, ownLane.parentDir)
      const parent = await statusOf(ownLane.parent)
      const facts = await laneFacts(ownLane, { child: "finished", parent: parent === "finished" ? "idle" : parent === "running" ? "busy" : "unknown" })
      await act(ownLane, laneEventAction(ownLane, facts, event, policy), facts, event, gen)
    }
    for (const lane of led) {
      const event: LaneEvent = { type: "check", subject: "parent" }
      const gen = await generationOf(lane.directory, lane.parentDir)
      const child = await statusOf(lane.child)
      const fresh = (await load(lane.child)) ?? lane
      // The parent's status is read now: an event does not say it is still idle after the debounce.
      const parentStatus = await statusOf(sessionID)
      const facts = await laneFacts(fresh, { child, parent: parentStatus === "finished" ? "idle" : parentStatus === "running" ? "busy" : "unknown" })
      await act(fresh, laneEventAction(fresh, facts, event, policy), facts, event, gen)
    }
  }

  const schedule = (sessionID: string, type: string, reason?: string, id?: string) => {
    if (disposed) return
    const held = pending.get(sessionID)
    if (held) {
      // succeeded + idle for one execution are one pass; the stronger outcome wins.
      if ((PRIORITY[type] ?? 0) > (PRIORITY[held.type] ?? 0)) {
        held.type = type
        if (reason !== undefined) held.reason = reason
        if (id !== undefined) held.id = id
      }
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      const entry = pending.get(sessionID)
      pending.delete(sessionID)
      if (!entry || disposed) return
      void serial(() => pass(sessionID, entry.type, entry.reason, entry.id)).catch((error) => console.error("subagent-worktree: lane pass failed", error))
    }, debounceMs)
    timers.add(timer)
    pending.set(sessionID, { type, ...(reason === undefined ? {} : { reason }), ...(id === undefined ? {} : { id }), timer })
  }

  /** Feed one server event. Cheap: it only schedules. */
  const handleEvent = (raw: unknown) => {
    const event = raw as { id?: unknown; type?: string; data?: { sessionID?: unknown; error?: unknown; reason?: unknown } }
    const eventID = typeof event.id === "string" ? event.id : undefined
    if (event.type === "session.created") {
      void maybeSweep()
      return
    }
    const sessionID = event.data?.sessionID
    if (typeof sessionID !== "string") return
    switch (event.type) {
      case "session.execution.failed":
        return schedule(sessionID, "failed", failureReason(event.data?.error), eventID)
      case "session.execution.interrupted":
        return schedule(sessionID, "interrupted", typeof event.data?.reason === "string" ? event.data.reason : "interrupted", eventID)
      case "session.execution.succeeded":
        return schedule(sessionID, "succeeded")
      case "session.idle":
        return schedule(sessionID, "idle")
    }
  }

  // --- idle gates ---------------------------------------------------------------------------

  type IdleInput = { sessionID: string; background?: ReadonlyArray<BackgroundJob> }

  /** Whether `sessionID` descends from `ancestor`: true, false, or undefined when a lookup failed. */
  const descends = async (sessionID: string, ancestor: string): Promise<boolean | undefined> => {
    let current: string | undefined = sessionID
    for (let depth = 0; depth < 8 && current !== undefined; depth++) {
      if (current === ancestor) return depth > 0
      const session: SessionLike | undefined = await withinLookup(deps.getSession(current))
      if (!session) return undefined
      current = session.parentID
    }
    return current === undefined ? false : undefined
  }

  const onIdle = async (input: IdleInput) => {
    if (disposed) return
    // A hook never throws: a coordination error means a deferred outcome (logged), never a removal.
    await serial(async () => {
      const lanes = (await deps.scan()).filter((lane) => lane.state === "active" && (lane.child === input.sessionID || lane.parent === input.sessionID))
      if (lanes.length === 0) return
      for (const lane of lanes) await deps.ensureClaim(lane)
      const jobs = input.background ?? []
      const running = new Set<string>()
      // If what is running could not be recorded, running work cannot be ruled out: nothing is removed this time.
      let holdsFailed = false
      const gateLanes = await Promise.all(
        lanes.map(async (lane) => {
          const gen = await generationOf(lane.directory, lane.parentDir)
          // Every kind of job counts, and the child's status is read, not inferred from the list.
          const known = new Map<string, boolean | undefined>()
          for (const job of jobs) {
            for (const id of [job.sessionID, job.childSessionID]) {
              if (typeof id === "string" && !known.has(id)) known.set(id, id === lane.child ? true : await descends(id, lane.child))
            }
          }
          const matched = laneBackgroundJobs(lane, jobs, (id) => known.get(id))
          const busy = matched[0]?.why
          // Any gate, child or parent, records what is running for this lane; the next gate that sees none clears it.
          const common = await deps.commonDir(lane.parentDir)
          if (common !== undefined) {
            try {
              await lockedWrite(common, lane.directory, { sessionID: input.sessionID, now, ...deps.lock }, () =>
                setHold(
                  common,
                  lane.directory,
                  input.sessionID,
                  matched.map(({ job }) => ({ kind: job.kind, id: job.shellID ?? job.childSessionID ?? job.sessionID ?? "unknown" })),
                  now(),
                ),
              )
              unsafeHolds.delete(canonical(lane.directory))
            } catch (error) {
              const why = error instanceof Error ? error.message : String(error)
              holdsFailed = true
              unsafeHolds.set(canonical(lane.directory), `its running work could not be recorded (${why})`)
              console.error(`subagent-worktree: could not record holds for ${lane.directory}:`, why)
            }
          }
          if (busy !== undefined && lane.parent === input.sessionID) running.add(lane.child)
          const child = busy !== undefined ? "running" : await statusOf(lane.child)
          if (child === "running" && lane.parent === input.sessionID) running.add(lane.child)
          return { lane, gen, facts: await laneFacts(lane, { child, parent: lane.parent === input.sessionID ? "idle" : "unknown" }) }
        }),
      )
      const gens = new Map(gateLanes.map((entry) => [entry.lane.child, entry.gen]))
      const gate = idleGateAction(
        { id: input.sessionID, runningChildren: running, now: now(), lastMessageAt: lastGate.get(input.sessionID) },
        gateLanes.map(({ lane, facts }) => ({ lane, facts })),
        policy,
      )
      for (const { lane, basis } of holdsFailed ? [] : gate.remove) {
        await removeLane(lane, basis, gens.get(lane.child) ?? -2, lane.parent === input.sessionID)
      }
      if (gate.message === undefined) return
      // Each notice is reserved on disk first; the message carries only the ones this instance won.
      const won: typeof gate.marks = []
      for (const entry of gate.marks) {
        const lane = gateLanes.find(({ lane: candidate }) => candidate.child === entry.child)?.lane
        if (lane && (await reserve(lane, entry.key)) === "ok") won.push(entry)
      }
      if (won.length === 0) return
      const lines = won.flatMap((entry) => (entry.line === undefined ? [] : [entry.line]))
      if (await send(input.sessionID, lines.length > 0 ? gateMessage(lines) : gate.message)) {
        lastGate.set(input.sessionID, now())
        for (const { child, key } of won) await mark(child, key)
      } else {
        for (const entry of won) {
          const lane = gateLanes.find(({ lane: candidate }) => candidate.child === entry.child)?.lane
          if (lane) await release(lane, [entry.key])
        }
      }
    }).catch((error) => console.error("subagent-worktree: idle gate failed:", error instanceof Error ? error.message : error))
  }

  // --- landings -----------------------------------------------------------------------------

  const onLanding = async (event: { tool: string; status: string; result?: unknown }) => {
    if (!LANDING_TOOLS.includes(event.tool) || event.status !== "completed") return
    const lanes = (await deps.scan()).filter((lane) => lane.state === "active")
    if (lanes.length === 0) return
    const gone = (path: string) => !existsSync(path)
    const lane = laneForLanding(event.result, lanes, canonical, gone)
    if (lane) {
      // Bookkeeping in the same critical section as every removal: retire only the record that was removed.
      await withLock(lane.directory, lane.parentDir, async () => {
        const stored = await load(lane.child)
        if (stored?.state === "active" && canonical(stored.directory) === canonical(lane.directory)) await save({ ...stored, state: "landed" })
      })
      await ctx.worktree.refresh({ projectID: lane.projectID } as never).catch(() => {})
      return
    }
  }

  // --- sweep --------------------------------------------------------------------------------

  const sweepKey = () => `sweep/at/${projectID ?? "none"}`

  type Entry = { directory: string }

  /** Who works in `directory`: "unknown" (so the worktree is kept) unless every page of the lookup was read. */
  const ownerOf = async (directory: string, minAgeMs: number): Promise<WorktreeFacts["owner"]> => {
    if (projectID === undefined) return "unknown"
    let query: Record<string, unknown> = { project: projectID, directory, archived: false, limit: 100 }
    for (let pages = 0; pages < 20; pages++) {
      const page = (await withinLookup(Promise.resolve(ctx.session.list(query as never)))) as
        | { data?: unknown; cursor?: { next?: string } }
        | undefined
      if (!page || !Array.isArray(page.data)) return "unknown"
      for (const raw of page.data as Array<{ time?: Record<string, unknown> }>) {
        const busy = toMillis(raw.time?.busy)
        const idle = toMillis(raw.time?.idle)
        const updated = toMillis(raw.time?.updated)
        if (isRunning({ busy, idle }) || (updated !== undefined && now() - updated < minAgeMs)) return "yes"
      }
      const next = page.cursor?.next
      if (!next) return "no"
      query = { cursor: next }
    }
    return "unknown"
  }

  const ageOf = async (directory: string): Promise<number | undefined> => {
    try {
      const info = await stat(join(directory, ".git"))
      const born = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs
      return Math.max(0, now() - born)
    } catch {
      return undefined
    }
  }

  const sweepFacts = async (directory: string, lane: Lane | undefined, minAgeMs: number): Promise<WorktreeFacts> => {
    const agentPath = lane !== undefined || [root, ...options.include.map(canonical)].some((base) => within(canonical(directory), base))
    const base = { path: directory, agentPath, ...(lane ? { branch: lane.branch } : {}) }
    if (!(await deps.exists(directory))) return { ...base, exists: false, owner: "unknown", ageMs: undefined, landed: false, dirty: undefined, ahead: undefined, unpushed: false }
    const records = await deliveryRecords(directory, lane?.parentDir ?? ctx.location.directory)
    const branch = lane?.branch ?? (await git.branch(directory))
    const [tip, porcelain, owner, ageMs] = await Promise.all([git.head(directory), git.porcelain(directory), ownerOf(directory, minAgeMs), (deps.age ?? ageOf)(directory)])
    const status = await git.status(directory, "origin/main")
    const busy = await busyTreeOf(directory, branch)
    let landed = false
    let closed = false
    const parentDir = lane?.parentDir ?? ctx.location.directory
    if (tip !== undefined && status !== undefined) {
      landed = records.heads.includes(tip) || status.ahead === 0 || (await git.isAncestor(directory, tip, "origin/main"))
      if (!landed) {
        const proofs = await proofsFor(parentDir)
        landed = proofs.merged.has(tip) || proofs.integrated.has(tip)
        // A pull request from this branch that is open now overrides an older closed one for the same commit;
        // an open list that failed or may be cut off proves nothing, so the lane is kept.
        closed = !landed && branch !== undefined && proofs.closed.has(tip) && proofs.openComplete && !proofs.open.has(branch)
      }
    }
    // Clean or dirty only in ignored files (status does not list ignored files), nothing running, and the owner gone for the grace period.
    const freeBuild =
      base.agentPath &&
      porcelain === "" &&
      busy === undefined &&
      (await holdReason(directory, parentDir)) === undefined &&
      (await ownerOf(directory, await buildGraceMs(directory))) === "no"
    const behindRemote = await git.run(["git", "-C", directory, "rev-list", "--count", "@{upstream}..HEAD"])
    const unpushed = behindRemote.code === 0 ? Number.parseInt(behindRemote.stdout.trim(), 10) > 0 : (status?.ahead ?? 0) > 0
    return {
      ...base,
      ...(branch ? { branch } : {}),
      exists: true,
      owner,
      ageMs,
      landed,
      // A denial (or unreadable records) or a gate-held worktree reads as "dirty": quarantined, never pruned.
      dirty:
        porcelain === undefined
          ? undefined
          : porcelain !== "" || busy !== undefined || records.block !== undefined || (await holdReason(directory, lane?.parentDir ?? ctx.location.directory)) !== undefined,
      ahead: status?.ahead,
      unpushed,
      closed,
      freeBuild,
    }
  }

  /** How long an owner must have been gone before build directories are freed: none on a nearly full disk. */
  const buildGraceMs = async (directory: string): Promise<number> =>
    isLowDisk(await (deps.build?.freeBytes ?? diskFreeBytes)(directory), options.lowDiskBytes) ? 0 : BUILD_GRACE_MS

  /**
   * Free the ignored build directories of one kept worktree. Under the same lock as a removal and after the
   * same fresh checks (generation unchanged, nothing running, owner still gone, tree still free of changes)
   * they are only renamed aside; the slow recursive delete runs after the lock is released, so a resume or a
   * hold write is never kept waiting on it. Fails closed: a lock, git or lookup failure detaches nothing.
   * A delete that fails leaves the detached directory in the worktree's git directory, out of git's view;
   * the next pass deletes it, and removing the worktree deletes it with that directory.
   */
  const freeBuildOf = async (directory: string, parentDir: string, gen: number, lane: Lane | undefined): Promise<string[]> => {
    await deps.build?.beforeLock?.(directory)
    const detached = await detachUnderLock(directory, parentDir, gen, lane)
    const freed: string[] = []
    for (const entry of detached) {
      if (await (deps.build?.deleteTrash ?? deleteDetached)(entry)) freed.push(entry.rel)
      else console.error(`subagent-worktree: could not delete ${entry.trash}; it is left in place`)
    }
    return freed
  }

  const detachUnderLock = async (directory: string, parentDir: string, gen: number, lane: Lane | undefined): Promise<Detached[]> => {
    try {
      return await withLock(directory, parentDir, async () => {
        const common = await deps.commonDir(parentDir)
        if (common === undefined) return []
        if (claimGeneration(readClaim(common, directory)) !== gen) return []
        if (unsafeHolds.has(canonical(directory)) || holdsState(common, directory, now()) !== undefined) return []
        if ((await git.porcelain(directory)) !== "" || (await busyTreeOf(directory, await git.branch(directory))) !== undefined) return []
        const refusal = await recheckFor(lane, directory, parentDir, false, { minAgeMs: await buildGraceMs(directory) })()
        if (refusal !== undefined) return []
        return detachBuildDirs(git.run, canonical(directory))
      })
    } catch (error) {
      console.error(`subagent-worktree: build directories of ${directory} left alone:`, error instanceof Error ? error.message : error)
      return []
    }
  }

  /** The plan for this project; with mode "prune" it is also carried out. Never forces, never touches a remote. */
  const sweep = async (mode: "report" | "prune"): Promise<{ plan: PlanEntry[]; text: string }> => {
    try {
      return await sweepUnsafe(mode)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      console.error("subagent-worktree: sweep failed:", why)
      return { plan: [], text: `subagent_worktree_sweep: failed (${why}); nothing was removed.` }
    }
  }

  const sweepUnsafe = async (mode: "report" | "prune"): Promise<{ plan: PlanEntry[]; text: string }> => {
    if (projectID === undefined) return { plan: [], text: "subagent_worktree_sweep: the host reports no project." }
    const minAgeMs = options.minAgeHours * HOUR
    const listed = (await withinLookup(Promise.resolve(ctx.worktree.list({ projectID } as never)))) as readonly Entry[] | undefined
    const lanes = (await deps.scan()).filter((lane) => lane.state === "active" && lane.projectID === projectID)
    const byDir = new Map(lanes.map((lane) => [canonical(lane.directory), lane]))
    const directories = new Map<string, string>()
    for (const entry of listed ?? []) directories.set(canonical(entry.directory), entry.directory)
    for (const lane of lanes) directories.set(canonical(lane.directory), lane.directory)
    const facts: WorktreeFacts[] = []
    const proven = new Map<string, { gen: number }>()
    for (const [key, directory] of directories) {
      // The commit and generation are read first: the removal runs only if both are unchanged.
      const gen = await generationOf(directory, byDir.get(key)?.parentDir ?? ctx.location.directory)
      facts.push(await sweepFacts(directory, byDir.get(key), minAgeMs))
      proven.set(key, { gen })
    }
    const plan = planSweep(facts, { minAgeMs })
    if (mode === "prune") {
      for (const entry of plan) {
        if (entry.verdict === "prune-registry") {
          await git.pruneWorktrees(ctx.location.directory)
          continue
        }
        const key = canonical(entry.path)
        const lane = byDir.get(key)
        const covered = proven.get(key)
        if (covered === undefined) continue
        const parentDir = lane?.parentDir ?? ctx.location.directory
        if (entry.verdict !== "prune") {
          if (entry.freeBuild && options.freeBuildDirs) {
            const freed = await freeBuildOf(entry.path, parentDir, covered.gen, lane)
            if (freed.length > 0) console.error(`subagent-worktree: freed ${freed.join(", ")} in ${entry.path}`)
          }
          continue
        }
        await removeVerified({
          directory: entry.path,
          projectID,
          branch: entry.deleteBranch ? entry.branch : undefined,
          parentDir,
          gen: covered.gen,
          basis: "landed",
          isLanded: entry.closedUnmerged ? closedProof(entry.path, entry.branch, parentDir, lane) : landedProof(entry.path, parentDir, lane),
          ...(lane ? { lane } : {}),
          recheck: recheckFor(lane, entry.path, parentDir, false, { minAgeMs }),
        })
      }
    }
    await ctx.storage.set("sweep/last", { at: now(), mode, plan })
    return { plan, text: formatPlan(plan, mode) }
  }

  const runSweep = (mode: "report" | "prune") => {
    const next = sweepChain.then(() => sweep(mode))
    sweepChain = next.catch(() => {})
    return next
  }

  /**
   * Heal sessions stranded by earlier removals (including ones other tools made): every session of this
   * project whose directory no longer exists is moved to the canonical checkout of its repository, else
   * the project root. Such a session cannot run, so this is safe. Each move is logged.
   */
  const repairSessions = async () => {
    if (projectID === undefined) return
    const lanes = await deps.scan()
    const parentOf = new Map(lanes.map((lane) => [lane.child, lane.parentDir]))
    // The project's own checkout: where this plugin runs. Its repository's canonical checkout is its fallback.
    const projectRoot = ctx.location.directory
    const canonicalMain = canonicalCheckout(await deps.commonDir(projectRoot), projectRoot)
    const result = await repairStrandedSessions(ctx.session as unknown as SessionApi, {
      projectID,
      // In order: the checkout the lane came from, the repository's canonical checkout, the project root.
      // The helper moves only to the first that exists, so a removed linked checkout is skipped.
      destinationsFor: (session) => [...new Set([parentOf.get(session.id), canonicalMain, projectRoot].filter((path): path is string => path !== undefined))],
      exists: deps.exists,
      log: (line) => console.error(`subagent-worktree: ${line}`),
    })
    if ("error" in result) console.error(`subagent-worktree: session repair skipped: ${result.error}`)
  }

  /** The background sweep: off, or throttled to once per `intervalHours` per project. */
  const maybeSweep = async () => {
    if (disposed || options.sweep === "off" || projectID === undefined) return
    try {
      const last = (await ctx.storage.get(sweepKey())) as number | undefined
      if (typeof last === "number" && now() - last < options.intervalHours * HOUR) return
      await ctx.storage.set(sweepKey(), now())
      await repairSessions().catch((error) => console.error("subagent-worktree: session repair failed:", error))
      await runSweep(options.sweep)
    } catch (error) {
      console.error("subagent-worktree: sweep failed", error)
    }
  }

  /** Record an explicit keep: the gate stays quiet about this lane until its state token changes. */
  const keep = async (child: string, reason: string): Promise<Lane | undefined> => {
    const lane = await load(child)
    if (lane?.state !== "active") return undefined
    const facts = await laneFacts(lane, { child: "unknown", parent: "unknown" })
    const kept = { ...lane, kept: { reason, token: stateToken(facts) } }
    await save(kept)
    return kept
  }

  // --- registration -------------------------------------------------------------------------

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const abort = new AbortController()
  let iterator: AsyncIterator<unknown> | undefined

  const start = async () => {
    iterator = ctx.event.subscribe({ types: [...EVENT_TYPES], signal: abort.signal } as never)[Symbol.asyncIterator]()
    const events = iterator
    void (async () => {
      for (;;) {
        const next = await events.next().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        try {
          handleEvent(next.value)
        } catch (error) {
          console.error("subagent-worktree: event handling failed", error)
        }
      }
    })()
    if (options.gates) {
      try {
        registrations.push(await ctx.session.hook("experimental.idle" as never, onIdle as never))
        gatesActive = true
      } catch {
        gatesActive = false
      }
    }
    if (options.sweep !== "off") {
      const timer = setTimeout(() => {
        timers.delete(timer)
        void maybeSweep()
      }, deps.sweepDelayMs ?? 30_000)
      timers.add(timer)
    }
  }

  const dispose = async () => {
    disposed = true
    abort.abort()
    await iterator?.return?.()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    pending.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
    await Promise.allSettled([chain, sweepChain])
    // The last chance to give back a reservation whose send failed; one still held is logged.
    for (const { lane } of [...unreleased.values()]) await flushReleases(lane)
  }

  /** Wait for scheduled and running passes; for tests and shutdown. */
  const settle = async () => {
    while (pending.size > 0) await new Promise((done) => setTimeout(done, debounceMs + 1))
    await Promise.allSettled([chain, sweepChain])
  }

  return { start, dispose, handleEvent, onIdle, onLanding, keep, removeForeground, generationOf, noteResume, sweep: runSweep, maybeSweep, settle }
}

export type Lifecycle = ReturnType<typeof createLifecycle>
