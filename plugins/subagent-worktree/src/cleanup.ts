/**
 * Lane cleanup: decide when a lane's worktree can go and remove it without losing work.
 *
 * Threat model is agent mistakes and crashes, not adversaries. Rules, in order:
 * a lane whose owner runs, or whose owner cannot be determined, is untouched; a lane with
 * uncommitted changes or commits on no remote and not merged is never removed (only
 * allow-listed build directories are freed); an empty or merged clean lane is removed with
 * its branch; a clean pushed-but-unmerged lane is kept while its parent lives, then its
 * worktree goes and the branch stays. Every removal re-verifies the recorded path first.
 *
 * Known limit: PR squash merges leave the lane branch a non-ancestor of its target, so such a
 * lane counts as unmerged and is kept until it is pushed and the parent is gone.
 */

import { existsSync, lstatSync } from "node:fs"
import { rm, statfs } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { physical, verifyCheckout } from "@srobroek/opencode-lib/checkout-marker"
import { SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git"
import type { Runner } from "./git.ts"
import { type Lane, LEASE_KEY, PENDING_PREFIX, type Pending, pendingKey } from "./lane.ts"

/** An owner idle this long may have its build directories freed even when its work is kept. */
export const GRACE_MS = 30 * 60_000
/** A sweep lease outlives one sweep; a crashed holder's lease expires after this. */
export const LEASE_MS = 5 * 60_000
/** A pending record younger than this may still belong to a spawn in flight. */
export const PENDING_MS = 10 * 60_000

/** Directories (relative to the worktree root) that may be deleted when git ignores them and tracks nothing in them. */
export const BUILD_DIRS: readonly string[] = [
  "target",
  "node_modules/.cache",
  ".turbo",
  ".next/cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
]

/** Files in a worktree's git directory that mark an operation in progress. */
const BUSY_MARKERS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock", "locked"]

export type Presence = "running" | "idle" | "gone" | "unknown"

export type GitFacts = {
  /** Uncommitted tracked changes or untracked (not ignored) files. */
  dirty: boolean
  /** Commits on HEAD since the lane's base. */
  ahead: number
  /** HEAD is an ancestor of the lane's target branch. */
  merged: boolean
  /** Some remote-tracking branch contains HEAD. */
  pushed: boolean
  /** A rebase, merge, cherry-pick, revert or bisect is in progress, or the worktree is locked. */
  busy: boolean
}

export type CleanupFacts = {
  owner: Presence
  parent: Presence
  /** Milliseconds since the owner last did anything. */
  inactiveMs: number
  graceMs: number
  lowDisk: boolean
  git: GitFacts | undefined
}

export type CleanupDecision =
  | { kind: "untouched"; reason: string }
  | { kind: "remove"; branch: "delete" | "keep"; reason: string }
  | { kind: "keep"; reason: string; freeBuild: boolean; report: boolean }

/** What to do with one lane. Pure: every input is a fact the caller gathered. */
export function decideCleanup(facts: CleanupFacts): CleanupDecision {
  const { git } = facts
  if (git === undefined) return { kind: "untouched", reason: "the lane's git state could not be read" }
  if (facts.owner === "running" || facts.owner === "unknown")
    return { kind: "untouched", reason: facts.owner === "running" ? "its session is running" : "its session could not be checked" }
  if (git.busy)
    return { kind: "keep", reason: "a git operation is in progress or the worktree is locked", freeBuild: false, report: true }
  const unmergedLocal = git.ahead > 0 && !git.merged && !git.pushed
  if (git.dirty || unmergedLocal) {
    const idle = facts.owner === "gone" || facts.inactiveMs >= facts.graceMs || facts.lowDisk
    return {
      kind: "keep",
      reason: git.dirty ? "it has uncommitted changes" : "it has commits that are on no remote and not merged",
      freeBuild: idle,
      report: true,
    }
  }
  if (git.ahead === 0 || git.merged) return { kind: "remove", branch: "delete", reason: git.ahead === 0 ? "it is empty" : "it is merged" }
  if (facts.parent === "gone") return { kind: "remove", branch: "keep", reason: "it is pushed and its parent is gone" }
  return { kind: "keep", reason: "it is pushed but not merged and its parent is still alive", freeBuild: false, report: false }
}

/** The path, as `git worktree list --porcelain` blocks: first entry is the main worktree. */
export type ListedWorktree = { path: string; locked: boolean }

export function parseListed(porcelain: string): ListedWorktree[] {
  return porcelain
    .split(/\n\n+/)
    .map((block) => block.split("\n"))
    .filter((lines) => lines.some((line) => line.startsWith("worktree ")))
    .map((lines) => ({
      path: lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "",
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
    }))
}

export type Verified = { real: string; gitDir: string }
export type Verification = ({ ok: true } & Verified) | { ok: false; reason: string }

export type CleanupDeps = {
  run: Runner
  now: () => number
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
    scan(prefix: string): Promise<Array<{ key: string; value: unknown }>>
  }
  /** Every lane record. */
  lanes: () => Promise<Lane[]>
  load: (child: string) => Promise<Lane | undefined>
  save: (lane: Lane) => Promise<void>
  /** How a session stands. `lastActivity` is epoch milliseconds. */
  presence: (sessionID: string) => Promise<{ presence: Presence; lastActivity?: number }>
  /** Whether a running session works in `directory`; `unknown` when the host cannot say. */
  runningInside: (lane: Lane, directory: string) => Promise<"none" | "some" | "unknown">
  /** Move the child home and remove the worktree. Must not force: it refuses dirty trees. */
  removeWorktree: (lane: Lane, real: string) => Promise<void>
  /** Tell the parent (queued, no turn) when it lives, else log. */
  report: (lane: Lane, parent: Presence, text: string) => Promise<void>
  withLane: <T>(child: string, work: () => Promise<T>) => Promise<T>
  /** Free bytes on the disk holding `path`; undefined when unknown. */
  freeBytes: (path: string) => Promise<number | undefined>
  lowDiskBytes: number
  log: (text: string) => void
  graceMs?: number
}

export type CleanupOutcome =
  | { action: "removed"; reason: string; branchDeleted: boolean }
  | { action: "kept"; reason: string; freedBytes: number }
  | { action: "untouched"; reason: string }

const free = async (path: string) => {
  try {
    const stats = await statfs(path)
    return stats.bavail * stats.bsize
  } catch {
    return undefined
  }
}

export const diskFreeBytes = free

export function createCleanup(deps: CleanupDeps) {
  const holder = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const graceMs = deps.graceMs ?? GRACE_MS

  const gitAt = (gitDir: string, real: string, args: string[]) =>
    deps.run(["git", ...SAFE_GIT_ARGS, "--git-dir", gitDir, "--work-tree", real, ...args])

  /** The recorded path is still this lane's own checkout of the recorded repository, unlocked and listed. */
  const verify = async (lane: Lane): Promise<Verification> => {
    const own = lane.ownership
    if (own === undefined) return { ok: false, reason: "the lane has no ownership record" }
    const real = physical(lane.directory)
    if (real === null) return { ok: false, reason: `${lane.directory} does not exist` }
    if (real !== own.physical) return { ok: false, reason: `${lane.directory} resolves to ${real}, not the recorded ${own.physical}` }
    if (dirname(real) !== own.root) return { ok: false, reason: `${real} is not directly under the recorded root ${own.root}` }
    const verdict = verifyCheckout(real, own.commonDir)
    if (verdict.state !== "same") return { ok: false, reason: `${real} is not a checkout of the recorded repository (${verdict.state})` }
    const listed = await deps.run(["git", ...SAFE_GIT_ARGS, "--git-dir", own.commonDir, "worktree", "list", "--porcelain"])
    if (listed.code !== 0) return { ok: false, reason: "git worktree list failed" }
    const entries = parseListed(listed.stdout)
    const at = entries.findIndex((entry) => physical(entry.path) === real)
    if (at < 0) return { ok: false, reason: `git does not list ${real}` }
    if (at === 0) return { ok: false, reason: `${real} is the main worktree` }
    if (entries[at]?.locked) return { ok: false, reason: `${real} is locked` }
    return { ok: true, real, gitDir: verdict.pin.GIT_DIR as string }
  }

  const factsOf = async (lane: Lane, v: Verified): Promise<GitFacts | undefined> => {
    const status = await gitAt(v.gitDir, v.real, ["status", "--porcelain", "--untracked-files=all"])
    const ahead = await gitAt(v.gitDir, v.real, ["rev-list", "--count", `${lane.base}..HEAD`])
    if (status.code !== 0 || ahead.code !== 0) return undefined
    let merged = false
    if (lane.target !== undefined) {
      merged = (await gitAt(v.gitDir, v.real, ["merge-base", "--is-ancestor", "HEAD", `refs/heads/${lane.target}`])).code === 0
    }
    const contained = await gitAt(v.gitDir, v.real, ["branch", "-r", "--contains", "HEAD"])
    return {
      dirty: status.stdout.trim() !== "",
      ahead: Number.parseInt(ahead.stdout.trim(), 10) || 0,
      merged,
      pushed: contained.code === 0 && contained.stdout.trim() !== "",
      busy: BUSY_MARKERS.some((name) => existsSync(join(v.gitDir, name))),
    }
  }

  /** Delete each allow-listed build directory that is a real ignored directory with nothing tracked in it. */
  const freeBuildDirs = async (v: Verified): Promise<number> => {
    const before = await deps.freeBytes(v.real)
    for (const rel of BUILD_DIRS) {
      const target = join(v.real, rel)
      try {
        const stat = lstatSync(target)
        if (stat.isSymbolicLink() || !stat.isDirectory() || physical(target) !== target) continue
      } catch {
        continue
      }
      const ignored = await gitAt(v.gitDir, v.real, ["check-ignore", "-q", "--", rel])
      const tracked = await gitAt(v.gitDir, v.real, ["ls-files", "--", rel])
      if (ignored.code !== 0 || tracked.code !== 0 || tracked.stdout.trim() !== "") continue
      await rm(target, { recursive: true, force: true }).catch(() => {})
    }
    const after = await deps.freeBytes(v.real)
    return before !== undefined && after !== undefined ? Math.max(0, after - before) : 0
  }

  const clean = (child: string): Promise<CleanupOutcome> =>
    deps.withLane(child, async () => {
      const lane = await deps.load(child)
      if (lane?.state !== "active" || !lane.ownership) return { action: "untouched", reason: "no active lane with an ownership record" }
      const v = await verify(lane)
      if (!v.ok) {
        deps.log(`subagent-worktree: lane ${lane.branch} left alone: ${v.reason}`)
        return { action: "untouched", reason: v.reason }
      }
      const owner = await deps.presence(lane.child)
      const parent = await deps.presence(lane.parent)
      if (owner.presence === "running" || owner.presence === "unknown") {
        return { action: "untouched", reason: owner.presence === "running" ? "its session is running" : "its session could not be checked" }
      }
      if ((await deps.runningInside(lane, v.real)) !== "none") return { action: "untouched", reason: "a live session works inside the worktree" }
      const room = deps.lowDiskBytes > 0 ? await deps.freeBytes(v.real) : undefined
      const lowDisk = room !== undefined && room < deps.lowDiskBytes
      const decision = decideCleanup({
        owner: owner.presence,
        parent: parent.presence,
        inactiveMs: owner.lastActivity === undefined ? 0 : Math.max(0, deps.now() - owner.lastActivity),
        graceMs,
        lowDisk,
        git: await factsOf(lane, v),
      })
      if (decision.kind === "untouched") return { action: "untouched", reason: decision.reason }

      if (decision.kind === "remove") {
        // Re-verify right before removal: the checkout may have changed since the facts were read.
        const again = await verify(lane)
        const facts = again.ok ? await factsOf(lane, again) : undefined
        if (!again.ok || again.real !== v.real || facts === undefined || facts.dirty || facts.busy) {
          return { action: "untouched", reason: "the lane changed while cleanup was deciding" }
        }
        try {
          await deps.removeWorktree(lane, v.real)
        } catch (error) {
          deps.log(`subagent-worktree: could not remove ${v.real}: ${error instanceof Error ? error.message : String(error)}`)
          return { action: "untouched", reason: "the worktree could not be removed" }
        }
        if (existsSync(v.real)) return { action: "untouched", reason: "the worktree is still there after removal" }
        await deps.save({ ...lane, state: "removed" })
        let branchDeleted = false
        if (decision.branch === "delete") {
          branchDeleted = (await deps.run(["git", ...SAFE_GIT_ARGS, "--git-dir", lane.ownership.commonDir, "branch", "--quiet", "-d", lane.branch])).code === 0
        }
        return { action: "removed", reason: decision.reason, branchDeleted }
      }

      const freed = decision.freeBuild ? await freeBuildDirs(v) : 0
      if (lowDisk && decision.freeBuild) deps.log(`subagent-worktree: low disk space; freed build directories in ${v.real}`)
      const state = lane.ownership.cleanup ?? {}
      const finding = `kept: ${decision.reason}`
      if (decision.report && state.reported !== finding) {
        const tail = freed > 0 ? ` Freed ${freed} bytes of build directories.` : ""
        await deps.report(lane, parent.presence, `subagent-worktree: lane ${lane.branch} at ${lane.directory} was not removed because ${decision.reason}.${tail}`)
        await deps.save({ ...lane, ownership: { ...lane.ownership, cleanup: { ...state, reported: finding, freedBytes: (state.freedBytes ?? 0) + freed } } })
      } else if (freed > 0) {
        await deps.save({ ...lane, ownership: { ...lane.ownership, cleanup: { ...state, freedBytes: (state.freedBytes ?? 0) + freed } } })
      }
      return { action: "kept", reason: decision.reason, freedBytes: freed }
    })

  /** Clear or report pending records: a spawn that crashed between creating the worktree and saving its lane. */
  const sweepPending = async (lanes: readonly Lane[]) => {
    for (const { key, value } of await deps.storage.scan(PENDING_PREFIX)) {
      const pending = value as Partial<Pending> | undefined
      if (typeof pending?.name !== "string" || typeof pending.createdAt !== "number") {
        await deps.storage.remove(key)
        continue
      }
      if (deps.now() - pending.createdAt < PENDING_MS) continue
      if (!lanes.some((lane) => basename(lane.directory) === pending.name)) {
        deps.log(`subagent-worktree: a worktree named ${pending.name} may have been left by a spawn that stopped early; check \`git worktree list\``)
      }
      await deps.storage.remove(pendingKey(pending.name))
    }
  }

  let flight: Promise<{ swept: number; skipped?: string }> | undefined

  /** One sweep over every active lane. Single-flight, and a lease key keeps two servers from sweeping at once. */
  const sweep = (options: { skip?: readonly string[] } = {}) => {
    if (flight) return flight
    flight = (async () => {
      const lease = (await deps.storage.get(LEASE_KEY)) as { holder?: string; until?: number } | undefined
      if (lease?.holder !== undefined && lease.holder !== holder && (lease.until ?? 0) > deps.now()) {
        return { swept: 0, skipped: "another server is sweeping" }
      }
      await deps.storage.set(LEASE_KEY, { holder, until: deps.now() + LEASE_MS })
      try {
        const lanes = await deps.lanes()
        await sweepPending(lanes)
        const named = options.skip ?? []
        const todo = lanes.filter((lane) => lane.state === "active" && lane.ownership && !named.some((text) => text.includes(lane.directory)))
        for (const lane of todo) await clean(lane.child)
        return { swept: todo.length }
      } finally {
        await deps.storage.remove(LEASE_KEY)
      }
    })().finally(() => {
      flight = undefined
    })
    return flight
  }

  return { clean, sweep, verify }
}

export type Cleanup = ReturnType<typeof createCleanup>
