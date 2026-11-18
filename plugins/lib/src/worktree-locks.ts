/**
 * Coordination state shared by every plugin instance that works on one repository's worktrees.
 *
 * Plugins load once per location: the parent's checkout and each lane's worktree run their own
 * instance, so an in-memory lock, generation or hold coordinates nothing between them. This state
 * lives on disk, repository-scoped, next to the lane claims:
 *
 *   <common>/opencode/locks/<sha1(dir)>.lock                   one lock per worktree
 *   <common>/opencode/holds/<sha1(dir)>/<sha1(session)>.json   running background jobs, per session
 *
 * The lock is the Beads embedded write lock's protocol (`lease-lock.ts`). Everything that reads or
 * writes this state for a worktree takes that lock around the read-decide-act or the write, so
 * readers and writers are serialised.
 */

import { createHash, randomUUID } from "node:crypto"
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type LeaseOptions, withLease } from "./lease-lock.ts"
import { canonicalDirectory, type Read } from "./worktree-claims.ts"

export const HOLD_EXPIRY_MS = 24 * 3_600_000

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex")
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The lease: a hold nobody renews expires after this. */
export const LOCK_TTL_MS = 120_000

export const lockFile = (commonDir: string, directory: string) =>
  join(commonDir, "opencode", "locks", `${sha1(canonicalDirectory(directory))}.lock`)

export class LockTimeout extends Error {
  constructor(
    readonly directory: string,
    detail = "",
  ) {
    super(`could not lock ${directory}${detail === "" ? "" : ` (${detail})`}`)
    this.name = "LockTimeout"
  }
}

export type LockOptions = {
  sessionID: string
  ttlMs?: number
  renewMs?: number
  /** How long to wait for a busy lock before it counts as held. */
  waitMs?: number
  now?: () => number
  host?: string
  alive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  seams?: LeaseOptions["seams"]
}

/**
 * Run `work` holding the worktree's on-disk lock. The protocol is the Beads embedded write lock's
 * (see `lease-lock.ts`): a lease renewed on a heartbeat, takeover of abandoned holders under a
 * steal lock. Re-entrant along one async call chain. Throws {@link LockTimeout} if it cannot be taken.
 */
export async function withDiskLock<T>(commonDir: string, directory: string, options: LockOptions, work: () => Promise<T>): Promise<T> {
  const path = lockFile(commonDir, directory)
  mkdirSync(join(path, ".."), { recursive: true })
  const result = await withLease(path, {
    owner: options.sessionID,
    leaseMs: options.ttlMs ?? LOCK_TTL_MS,
    waitMs: options.waitMs ?? 30_000,
    ...(options.renewMs === undefined ? {} : { renewMs: options.renewMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.alive === undefined ? {} : { alive: options.alive }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.seams === undefined ? {} : { seams: options.seams }),
  }, work)
  if (result.kind === "done") return result.value
  throw new LockTimeout(directory, result.reason)
}

// --- holds: running background work, written by every idle gate ------------------------------

export type HoldJob = { kind: string; id: string }
export type SessionHold = { sessionID: string; directory: string; jobs: readonly HoldJob[]; updatedAt: number }

export function parseHold(value: unknown): SessionHold | undefined {
  if (!isObject(value)) return undefined
  const { sessionID, directory, jobs, updatedAt } = value
  if (typeof sessionID !== "string" || typeof directory !== "string" || typeof updatedAt !== "number" || !Array.isArray(jobs)) return undefined
  const parsed: HoldJob[] = []
  for (const job of jobs) {
    if (!isObject(job) || typeof job.kind !== "string" || typeof job.id !== "string") return undefined
    parsed.push({ kind: job.kind, id: job.id })
  }
  return { sessionID, directory, jobs: parsed, updatedAt }
}

const holdsDir = (commonDir: string, directory: string) => join(commonDir, "opencode", "holds", sha1(canonicalDirectory(directory)))
const holdFile = (commonDir: string, directory: string, sessionID: string) => join(holdsDir(commonDir, directory), `${sha1(sessionID)}.json`)

/**
 * Record (or, with no jobs, clear) what `sessionID` has running in `directory`. One file per
 * session, replaced atomically, so no two writers ever read-modify-write the same file.
 */
export function setHold(commonDir: string, directory: string, sessionID: string, jobs: readonly HoldJob[], now: number) {
  const path = holdFile(commonDir, directory, sessionID)
  if (jobs.length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(holdsDir(commonDir, directory), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify({ sessionID, directory, jobs, updatedAt: now } satisfies SessionHold))
  renameSync(temp, path)
}

/** Every session's hold for `directory`. `unreadable` when the directory or any entry could not be read. */
export function readHolds(commonDir: string, directory: string): { holds: SessionHold[]; unreadable: boolean; missing?: boolean } {
  const dir = holdsDir(commonDir, directory)
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT"
    return { holds: [], unreadable: !absent, ...(absent ? { missing: true } : {}) }
  }
  const holds: SessionHold[] = []
  let unreadable = false
  for (const name of names) {
    try {
      const hold = parseHold(JSON.parse(readFileSync(join(dir, name), "utf8")))
      if (hold === undefined) unreadable = true
      else holds.push(hold)
    } catch {
      unreadable = true
    }
  }
  return { holds, unreadable }
}

/** Why background work blocks a removal, or undefined. Entries older than the expiry (a crashed host) are ignored. Pure. */
export function holdBlock(read: { holds: readonly SessionHold[]; unreadable: boolean }, now: number, expiryMs: number = HOLD_EXPIRY_MS): string | undefined {
  if (read.unreadable) return "the background-work records cannot be read"
  const live = read.holds.find((hold) => hold.jobs.length > 0 && now - hold.updatedAt < expiryMs)
  if (live === undefined) return undefined
  const first = live.jobs[0]
  return `session ${live.sessionID} has ${live.jobs.length} background job(s) running (${first?.kind} ${first?.id})`
}

export type { Read }

/** Whether the coordination root can be written (holds, locks, claims). Creates it when missing. */
export function coordinationWritable(commonDir: string): boolean {
  const root = join(commonDir, "opencode")
  try {
    mkdirSync(root, { recursive: true })
    accessSync(root, constants.W_OK)
    const probe = join(root, `.probe.${randomUUID()}`)
    writeFileSync(probe, "")
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** Whether a session's hold for `directory` can be written right now (a real probe write, in the holds directory when it exists). */
export function holdsWritable(commonDir: string, directory: string): boolean {
  // The exact directory holds are written to, created if need be: a probe anywhere else (the
  // coordination root, say) proves nothing when `holds/` itself is read-only. Any error is unsafe.
  const dir = holdsDir(commonDir, directory)
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.probe.${randomUUID()}`)
    writeFileSync(probe, "")
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Why background work or an unusable coordination store blocks a removal of `directory`, or
 * undefined. Run before every removal, under the lock. The holds store must be writable whether or
 * not it has entries: if it is not, the gates that would record running work could not have, so
 * "no live entries" proves nothing. Expired entries are ignored; unreadable ones block.
 */
export function holdsState(commonDir: string, directory: string, now: number, expiryMs: number = HOLD_EXPIRY_MS): string | undefined {
  const read = readHolds(commonDir, directory)
  const blocked = holdBlock(read, now, expiryMs)
  if (blocked !== undefined) return blocked
  if (!holdsWritable(commonDir, directory)) return "the coordination store is not writable, so running work cannot be ruled out"
  return undefined
}

/**
 * The one removal boundary. Under the worktree's on-disk lock: `recheck` (claim, holds, landing
 * records and denials, the final cleanup proofs: whatever the caller must confirm last) and, only
 * if it returns no refusal, `remove` (the worktree removal and the compare-and-delete of its ref).
 * Every remover, in every plugin, goes through here, so they exclude each other on one lock name.
 * A lock that cannot be taken is a refusal, not an error.
 */
export async function lockedWorktreeRemoval<T>(
  commonDir: string,
  directory: string,
  lock: LockOptions,
  steps: { recheck: () => Promise<string | undefined>; remove: () => Promise<T> },
): Promise<{ removed: false; reason: string } | { removed: true; value: T }> {
  let entered = false
  try {
    return await withDiskLock(commonDir, directory, lock, async () => {
      entered = true
      const reason = await steps.recheck()
      if (reason !== undefined) return { removed: false as const, reason }
      return { removed: true as const, value: await steps.remove() }
    })
  } catch (error) {
    // Failing to take the lock (contention, an unwritable store) is a refusal; a failure inside the steps is not ours to mask.
    if (entered) throw error
    const message = error instanceof LockTimeout ? `the worktree is locked by another remover (${error.message})` : `the lock could not be taken (${error instanceof Error ? error.message : String(error)})`
    return { removed: false, reason: message }
  }
}

/**
 * A short write to coordination state (a hold, a landing record, a denial, a claim, a resume bump)
 * under the worktree's lock, so it cannot land between a remover's last look and its removal.
 * Re-entrant: inside a removal's own critical section it just runs.
 */
export function lockedWrite<T>(commonDir: string, directory: string, options: LockOptions, write: () => T): Promise<T> {
  return withDiskLock(commonDir, directory, { waitMs: 10_000, ...options }, async () => write())
}
