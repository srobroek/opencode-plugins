/**
 * Shared on-disk state for "one remover per worktree".
 *
 * Two plugins touch the same agent worktrees: `subagent-worktree` creates them as lanes and
 * `delivery` records landings and could clean them up. They must not each remove on their
 * own snapshot, and they cannot import each other (each plugin bundles its own copy of this
 * lib, so module state is not shared either). The state therefore lives on disk, under the
 * repository's git common directory, which every worktree of the repository shares:
 *
 *   <git-common-dir>/opencode/lane-claims/<sha1(canonical dir)>.json   one per lane
 *   <git-common-dir>/opencode/landings/<receiptId>.json                one per landing delivery has not finished
 *
 * A claim means "subagent-worktree owns this worktree; delivery never removes it". A landing
 * record carries delivery's facts for the owner to read: the landed head and any denial.
 * Parsers are pure; the fs adapters are thin and bounded. A file that cannot be read is
 * reported as such, never as absent, so callers fail closed.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const MAX_FILE_BYTES = 64 * 1024
const MAX_LANDINGS = 500

export type LaneClaim = {
  directory: string
  branch: string
  sessionID: string
  parentID: string
  createdAt: number
  /**
   * Bumped, under the directory lock, by every resume of the lane's child. A removal captures it
   * before collecting facts and aborts if it changed. Plugins load once per location, so this
   * counter has to live on disk, not in memory.
   */
  generation: number
  /** When the child was last resumed, for the resume window. */
  resumedAt?: number
}

/** What delivery records about a landing whose worktree is not removed yet. */
export type LandingRecord = {
  receiptId: string
  /** The worktree the receipt names. */
  worktree: string
  /** The PR head that was merged: the landed proof for a worktree whose HEAD is still that commit. */
  headRefOid: string
  /** The session that ran `delivery_land`. */
  sessionID: string
  landedAt: number
  /** The inline cleanup (or an explicit call) was refused; only an authorized explicit call clears it. */
  denied?: { at: number; sessionID: string }
  /** The beads reminder was sent. */
  nudged?: boolean
}

export type Read<T> = { kind: "missing" } | { kind: "unreadable"; reason: string } | { kind: "present"; value: T }

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)
const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function parseClaim(value: unknown): LaneClaim | undefined {
  if (!isObject(value)) return undefined
  const directory = text(value.directory)
  const branch = text(value.branch)
  const sessionID = text(value.sessionID)
  const parentID = text(value.parentID)
  const createdAt = finite(value.createdAt)
  if (!directory || !branch || !sessionID || !parentID || createdAt === undefined) return undefined
  const resumedAt = finite(value.resumedAt)
  return { directory, branch, sessionID, parentID, createdAt, generation: finite(value.generation) ?? 0, ...(resumedAt === undefined ? {} : { resumedAt }) }
}

export function parseLanding(value: unknown): LandingRecord | undefined {
  if (!isObject(value)) return undefined
  const receiptId = text(value.receiptId)
  const worktree = text(value.worktree)
  const headRefOid = text(value.headRefOid)
  const sessionID = text(value.sessionID)
  const landedAt = finite(value.landedAt)
  if (!receiptId || !worktree || !headRefOid || !sessionID || landedAt === undefined) return undefined
  const denied = isObject(value.denied) ? value.denied : undefined
  const deniedAt = finite(denied?.at)
  const deniedBy = text(denied?.sessionID)
  return {
    receiptId,
    worktree,
    headRefOid,
    sessionID,
    landedAt,
    ...(deniedAt !== undefined && deniedBy ? { denied: { at: deniedAt, sessionID: deniedBy } } : {}),
    ...(value.nudged === true ? { nudged: true } : {}),
  }
}

/** The real path when it exists, else the resolved one: claims and landings compare by this. */
export function canonicalDirectory(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function claimKey(directory: string): string {
  return createHash("sha1").update(canonicalDirectory(directory)).digest("hex")
}

export const claimFile = (commonDir: string, directory: string) =>
  join(commonDir, "opencode", "lane-claims", `${claimKey(directory)}.json`)

/** Receipt ids are `<epoch>-<hex>`; anything else cannot name a file here. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/
export const landingFile = (commonDir: string, receiptId: string) => {
  if (!SAFE_ID.test(receiptId)) throw new Error(`unsafe receipt id ${JSON.stringify(receiptId)}`)
  return join(commonDir, "opencode", "landings", `${receiptId}.json`)
}

function readJson<T>(path: string, parse: (value: unknown) => T | undefined): Read<T> {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable", reason: (error as Error).message }
  }
  if (raw.length > MAX_FILE_BYTES) return { kind: "unreadable", reason: "file too large" }
  try {
    const value = parse(JSON.parse(raw))
    return value === undefined ? { kind: "unreadable", reason: "unrecognised content" } : { kind: "present", value }
  } catch (error) {
    return { kind: "unreadable", reason: (error as Error).message }
  }
}

function writeAtomic(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temp, `${JSON.stringify(value)}\n`)
  renameSync(temp, path)
}

export const readClaim = (commonDir: string, directory: string): Read<LaneClaim> =>
  readJson(claimFile(commonDir, directory), parseClaim)

export function writeClaim(commonDir: string, claim: Omit<LaneClaim, "generation"> & { generation?: number }) {
  writeAtomic(claimFile(commonDir, claim.directory), { ...claim, generation: claim.generation ?? claim.createdAt })
}

/** The generation a claim read carries; -1 when there is no readable claim (so a later claim never matches it). Pure. */
export function claimGeneration(read: Read<LaneClaim>): number {
  return read.kind === "present" ? read.value.generation : -1
}

/**
 * Record a resume: generation + 1 and `resumedAt`. The caller holds the directory lock. Returns the
 * new generation, or -1 when the claim is missing or unreadable.
 */
export function bumpClaim(commonDir: string, directory: string, now: number): number {
  const read = readClaim(commonDir, directory)
  if (read.kind !== "present") return -1
  const next = { ...read.value, generation: read.value.generation + 1, resumedAt: now }
  writeAtomic(claimFile(commonDir, directory), next)
  return next.generation
}

export function removeClaim(commonDir: string, directory: string) {
  rmSync(claimFile(commonDir, directory), { force: true })
}

export const readLanding = (commonDir: string, receiptId: string): Read<LandingRecord> =>
  readJson(landingFile(commonDir, receiptId), parseLanding)

export function writeLanding(commonDir: string, record: LandingRecord) {
  writeAtomic(landingFile(commonDir, record.receiptId), record)
}

export function removeLanding(commonDir: string, receiptId: string) {
  rmSync(landingFile(commonDir, receiptId), { force: true })
}

/**
 * Every landing record. `unreadable` is set when the directory or any record could not be read,
 * so a caller that needs "no denial" can refuse to conclude it.
 */
export function listLandings(commonDir: string): { records: LandingRecord[]; unreadable: boolean } {
  const directory = join(commonDir, "opencode", "landings")
  if (!existsSync(directory)) return { records: [], unreadable: false }
  let names: string[]
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"))
  } catch {
    return { records: [], unreadable: true }
  }
  if (names.length > MAX_LANDINGS) return { records: [], unreadable: true }
  const records: LandingRecord[] = []
  let unreadable = false
  for (const name of names) {
    const read = readJson(join(directory, name), parseLanding)
    if (read.kind === "present") records.push(read.value)
    else if (read.kind === "unreadable") unreadable = true
  }
  return { records, unreadable }
}

/** The landing records that name `directory`. Pure. */
export function landingsFor(records: readonly LandingRecord[], directory: string): LandingRecord[] {
  const want = canonicalDirectory(directory)
  return records.filter((record) => canonicalDirectory(record.worktree) === want)
}

export type Ownership = { owner: "none" } | { owner: "lane"; claim: LaneClaim } | { owner: "unknown"; reason: string }

/** Who may remove `directory`: a lane's claim means subagent-worktree only; an unreadable claim means nobody. Pure. */
export function ownershipOf(read: Read<LaneClaim>): Ownership {
  if (read.kind === "present") return { owner: "lane", claim: read.value }
  if (read.kind === "unreadable") return { owner: "unknown", reason: read.reason }
  return { owner: "none" }
}
