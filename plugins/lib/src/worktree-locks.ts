/**
 * Coordination state shared by every plugin instance that works on one repository's worktrees.
 *
 * Plugins load once per location: the parent's checkout and each lane's worktree run their own
 * instance, so an in-memory lock, generation or hold coordinates nothing between them. This state
 * lives on disk, repository-scoped, next to the lane claims:
 *
 *   <common>/opencode/locks/<sha1(dir)>.lock               one lock per worktree
 *   <common>/opencode/holds/<sha1(dir)>/<sha1(session)>.json  running background jobs, per session
 *
 * The lock is created exclusively (a hard link from a fully written temp file, so the file is
 * never seen half-written and creation fails if it exists). A holder that died is detected, never
 * guessed: a lock is broken only when it is older than the TTL and its pid is not alive on this host.
 */

import { createHash, randomUUID } from "node:crypto"
import { accessSync, constants, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { canonicalDirectory, type Read } from "./worktree-claims.ts"

export const LOCK_TTL_MS = 2 * 60_000
/** A `.break` file older than this belongs to a crashed breaker. */
export const BREAK_TTL_MS = 30_000
export const HOLD_EXPIRY_MS = 24 * 3_600_000

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex")
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export type LockInfo = { pid: number; host: string; sessionID: string; acquiredAt: number; token: string }

export function parseLock(value: unknown): LockInfo | undefined {
  if (!isObject(value)) return undefined
  const { pid, host, sessionID, acquiredAt, token } = value
  if (typeof pid !== "number" || !Number.isInteger(pid) || typeof host !== "string" || typeof sessionID !== "string") return undefined
  if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt) || typeof token !== "string") return undefined
  return { pid, host, sessionID, acquiredAt, token }
}

/**
 * Whether a lock may be broken. Only when it is older than the TTL **and** its holder is provably
 * gone: same host, pid not alive. A lock from another host, or whose holder is alive, is never
 * stale however old. A lock file nobody can parse is judged by its mtime alone. Pure.
 */
export function lockIsStale(
  info: LockInfo | undefined,
  facts: { now: number; ttlMs: number; host: string; alive: (pid: number) => boolean; mtimeMs?: number },
): boolean {
  if (info === undefined) return facts.mtimeMs !== undefined && facts.now - facts.mtimeMs > facts.ttlMs
  if (facts.now - info.acquiredAt <= facts.ttlMs) return false
  if (info.host !== facts.host) return false
  return !facts.alive(info.pid)
}

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export const lockFile = (commonDir: string, directory: string) =>
  join(commonDir, "opencode", "locks", `${sha1(canonicalDirectory(directory))}.lock`)

export class LockTimeout extends Error {
  constructor(readonly directory: string) {
    super(`could not lock ${directory}`)
    this.name = "LockTimeout"
  }
}

/** Seams for tests: run between validating a stale lock and breaking it. */
export type LockSeams = { afterValidate?: () => Promise<void> | void }

export type LockOptions = {
  sessionID: string
  seams?: LockSeams
  ttlMs?: number
  /** Attempts before giving up, with `delayMs(attempt)` between them. */
  attempts?: number
  delayMs?: (attempt: number) => number
  now?: () => number
  host?: string
  alive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

const readLock = (path: string): { raw: string; info: LockInfo | undefined; mtimeMs: number } | undefined => {
  try {
    const raw = readFileSync(path, "utf8")
    let info: LockInfo | undefined
    try {
      info = parseLock(JSON.parse(raw))
    } catch {}
    return { raw, info, mtimeMs: statSync(path).mtimeMs }
  } catch {
    return undefined
  }
}

/** Whether two lock reads are the same holding: token, pid, host and acquiredAt. Pure. */
export function sameLock(a: LockInfo | undefined, b: LockInfo | undefined, rawA?: string, rawB?: string): boolean {
  if (a === undefined || b === undefined) return a === b && rawA !== undefined && rawA === rawB
  return a.token === b.token && a.pid === b.pid && a.host === b.host && a.acquiredAt === b.acquiredAt
}

/**
 * Break a lock that was judged stale. Two breakers must not both act on the same stale content: the
 * slower one would unlink the lock the faster one just created. So breaking itself takes a
 * `<lock>.break` file exclusively; while holding it the lock is read again, and it is unlinked only
 * if it is still exactly the content that was judged. A `.break` file older than 30 s belongs to a
 * crashed breaker and is removed directly: safe, because breaking only ever unlinks a lock whose
 * content was confirmed under the break lock. Normal acquisition never touches `.break`.
 */
function breakStale(
  path: string,
  judged: { raw: string; info: LockInfo | undefined },
  who: { now: () => number; token: string; host: string; sessionID: string },
): void {
  const breakPath = `${path}.break`
  const temp = `${breakPath}.${who.token}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ pid: process.pid, host: who.host, sessionID: who.sessionID, acquiredAt: who.now(), token: who.token }))
    try {
      linkSync(temp, breakPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // Someone is breaking, or crashed while doing so.
      try {
        if (who.now() - statSync(breakPath).mtimeMs > BREAK_TTL_MS) rmSync(breakPath, { force: true })
      } catch {}
      return
    }
  } finally {
    rmSync(temp, { force: true })
  }
  try {
    const now = readLock(path)
    // Still exactly the lock that was judged? Then it is stale and nobody replaced it.
    if (now !== undefined && sameLock(now.info, judged.info, now.raw, judged.raw)) rmSync(path, { force: true })
  } finally {
    const mine = (() => {
      try {
        return (JSON.parse(readFileSync(breakPath, "utf8")) as { token?: string }).token === who.token
      } catch {
        return false
      }
    })()
    if (mine) rmSync(breakPath, { force: true })
  }
}

/** Run `work` holding the on-disk lock for `directory`. Throws {@link LockTimeout} if it cannot be taken. */
export async function withDiskLock<T>(commonDir: string, directory: string, options: LockOptions, work: () => Promise<T>): Promise<T> {
  const path = lockFile(commonDir, directory)
  const now = options.now ?? Date.now
  const host = options.host ?? hostname()
  const hostName = hostname()
  const alive = options.alive ?? processAlive
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS
  const attempts = options.attempts ?? 60
  const delayMs = options.delayMs ?? ((attempt) => Math.min(250, 10 * 2 ** Math.min(attempt, 5)))
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)))
  const token = randomUUID()
  mkdirSync(join(path, ".."), { recursive: true })

  const tryCreate = (): boolean => {
    const temp = `${path}.${token}.tmp`
    const info: LockInfo = { pid: process.pid, host, sessionID: options.sessionID, acquiredAt: now(), token }
    writeFileSync(temp, JSON.stringify(info))
    try {
      linkSync(temp, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    } finally {
      rmSync(temp, { force: true })
    }
  }

  let held = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (tryCreate()) {
      held = true
      break
    }
    const current = readLock(path)
    if (current === undefined) continue // released between the two calls
    if (lockIsStale(current.info, { now: now(), ttlMs, host, alive, mtimeMs: current.mtimeMs })) {
      await options.seams?.afterValidate?.()
      breakStale(path, current, { now, token, host: hostName, sessionID: options.sessionID })
      continue
    }
    await sleep(delayMs(attempt))
  }
  if (!held) throw new LockTimeout(directory)
  try {
    return await work()
  } finally {
    if (readLock(path)?.info?.token === token) rmSync(path, { force: true })
  }
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

/**
 * Why background work or an unusable coordination store blocks a removal of `directory`, or
 * undefined. No holds directory is "no holds" only if holds could be written there: if the
 * coordination root is not writable, the gates that would have recorded work could not have, so
 * it is unsafe, not empty.
 */
export function holdsState(commonDir: string, directory: string, now: number, expiryMs: number = HOLD_EXPIRY_MS): string | undefined {
  const read = readHolds(commonDir, directory)
  const blocked = holdBlock(read, now, expiryMs)
  if (blocked !== undefined) return blocked
  if (read.missing === true && !coordinationWritable(commonDir)) return "the coordination store is not writable, so running work cannot be ruled out"
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
  try {
    return await withDiskLock(commonDir, directory, lock, async () => {
      const reason = await steps.recheck()
      if (reason !== undefined) return { removed: false as const, reason }
      return { removed: true as const, value: await steps.remove() }
    })
  } catch (error) {
    if (error instanceof LockTimeout) return { removed: false, reason: `the worktree is locked by another remover (${error.message})` }
    throw error
  }
}
