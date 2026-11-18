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
 * Squash merges leave the lane branch a non-ancestor of its target, so a lane whose commits git
 * cannot find in the target is also asked about: the pull request state first (`gh pr view`),
 * then a patch-id comparison against the default branch. When neither answers, the lane is kept.
 *
 * Git runs in a checkout whose config an agent may have changed, so every git call carries the
 * controls in {@link guardArgs}: no fsmonitor, no hooks, no optional locks, and every repository-
 * level `filter.*` and `diff.*.textconv` driver blanked, because `git status` runs clean filters on
 * files whose stat data changed and `git diff` runs textconv and external diff programs. Drivers
 * defined only in the user's own global or system config stay, so git-lfs files still read as
 * clean. Submodules are not inspected: their config is a separate repository, so a lane that has
 * any is left alone. Removal uses `git worktree remove` without `--force` under the same controls;
 * the host strategy's remover is not used because it can run project hooks.
 */

import { existsSync, lstatSync, renameSync } from "node:fs"
import { rm, statfs } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { physical, verifyCheckout } from "@srobroek/opencode-lib/checkout-marker"
import { SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git"
import type { Runner, RunResult } from "./git.ts"
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

/** Config files whose filter and diff drivers the user wrote: their `file:` origins in `git config --show-origin`. */
export function trustedConfigOrigins(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(home, ".config")
  return [`file:${join(home, ".gitconfig")}`, `file:${join(xdg, "git", "config")}`, "file:/etc/gitconfig", "file:/usr/local/etc/gitconfig", "file:/opt/homebrew/etc/gitconfig"]
}

/**
 * Config keys to blank so no repository-defined program runs: `git config --null --show-origin
 * --get-regexp` output in, `-c key=` arguments out. A key that cannot be written as `-c key=`
 * (it contains `=`) makes the whole answer undefined, which the caller treats as unsafe.
 */
export function neutralizers(output: string, trusted: readonly string[]): string[] | undefined {
  const fields = output.split("\0")
  const untrusted = new Set<string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const origin = fields[i] ?? ""
    const entry = fields[i + 1] ?? ""
    const key = entry.split("\n")[0] ?? ""
    if (key === "") continue
    if (!trusted.includes(origin)) untrusted.add(key)
  }
  const args: string[] = []
  for (const key of untrusted) {
    if (key.includes("=")) return undefined
    args.push("-c", `${key}=`)
  }
  return args
}

/**
 * Remove one allow-listed build directory without following a link anywhere on its path. Each path
 * component is checked with `lstat` and its inode remembered; just before the rename they are
 * checked again; the directory is renamed to a sibling (a rename never follows its last component)
 * and the result is compared with the inode first inspected. If a component was swapped for a link
 * in between, the rename acted on the wrong tree, so it is renamed back and nothing is deleted.
 */
export async function removeBuildDir(root: string, rel: string, beforeRename?: (target: string) => void | Promise<void>): Promise<boolean> {
  const inodes: Array<{ path: string; dev: number; ino: number }> = []
  let current = root
  try {
    for (const part of rel.split("/")) {
      current = join(current, part)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false
      inodes.push({ path: current, dev: stat.dev, ino: stat.ino })
    }
    const target = current
    if (physical(target) !== target) return false
    await beforeRename?.(target)
    for (const entry of inodes) {
      const stat = lstatSync(entry.path)
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== entry.dev || stat.ino !== entry.ino) return false
    }
    const trash = join(dirname(target), `.${basename(target)}.cleanup-${Math.random().toString(36).slice(2, 10)}`)
    renameSync(target, trash)
    const last = inodes[inodes.length - 1]
    let sound = false
    try {
      const moved = lstatSync(trash)
      sound = last !== undefined && moved.isDirectory() && moved.dev === last.dev && moved.ino === last.ino && physical(trash) === trash
    } catch {}
    if (!sound) {
      try {
        renameSync(trash, target)
      } catch {}
      return false
    }
    await rm(trash, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Spawns and resumes into a worktree against cleanup removing it. A spawn pins the directory while
 * it starts and for `holdMs` after (the child may not run yet); cleanup claims the directory only
 * when nothing is pinned, and a spawn that meets a claim is refused.
 */
export function createDirectoryFence(now: () => number, holdMs: number) {
  const spawning = new Map<string, { pins: number; until: number }>()
  const cleaning = new Set<string>()
  return {
    /** Begin a spawn or resume into `directory`; returns the call that ends it. Throws while cleanup removes the directory. */
    pin(directory: string): () => void {
      if (cleaning.has(directory)) throw new Error(`${directory} is being cleaned up; spawn again in a moment`)
      const entry = spawning.get(directory) ?? { pins: 0, until: 0 }
      entry.pins++
      spawning.set(directory, entry)
      let ended = false
      return () => {
        if (ended) return
        ended = true
        entry.pins--
        entry.until = now() + holdMs
      }
    },
    /** Take `directory` for cleanup; undefined while a spawn or resume holds it. */
    claim(directory: string): (() => void) | undefined {
      const entry = spawning.get(directory)
      if (entry && (entry.pins > 0 || entry.until > now())) return undefined
      if (cleaning.has(directory)) return undefined
      cleaning.add(directory)
      return () => void cleaning.delete(directory)
    },
  }
}

export type DirectoryFence = ReturnType<typeof createDirectoryFence>

export type Presence = "running" | "idle" | "gone" | "unknown"

export type GitFacts = {
  /** Uncommitted tracked changes or untracked (not ignored) files. */
  dirty: boolean
  /** The commit HEAD names; every decision is bound to it. */
  head: string
  /** Commits on HEAD since the lane's base. */
  ahead: number
  /** HEAD is an ancestor of the lane's target branch. */
  merged: boolean
  /** Some remote-tracking branch contains HEAD. */
  pushed: boolean
  /** A rebase, merge, cherry-pick, revert or bisect is in progress, or the worktree is locked. */
  busy: boolean
  /** The lane's work is finished with: its pull request merged (or its patches are on the default branch) or was closed. */
  done?: "merged" | "closed"
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
  const unmergedLocal = git.ahead > 0 && !git.merged && !git.pushed && git.done === undefined
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
  if (git.done === "merged") return { kind: "remove", branch: "delete", reason: "its pull request was merged or its patches are on the default branch" }
  if (git.done === "closed") return { kind: "remove", branch: "keep", reason: "its pull request was closed without merging; the branch is kept" }
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

export type Verified = { real: string; gitDir: string; /** git's global arguments for every call in this checkout: see the module comment. */ guard: string[] }
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
  /** Whether a session works in `directory` (running, or just started there); `unknown` when the host cannot say. */
  runningInside: (lane: Lane, directory: string) => Promise<"none" | "some" | "unknown">
  /** Move the child home and remove the worktree with `guard` as git's global arguments. Must not force. */
  removeWorktree: (lane: Lane, real: string, guard: readonly string[]) => Promise<void>
  /** Tell the parent (queued, no turn) when it lives, else log. */
  report: (lane: Lane, parent: Presence, text: string) => Promise<void>
  withLane: <T>(child: string, work: () => Promise<T>) => Promise<T>
  /** Spawns and resumes against removal. */
  fence: DirectoryFence
  /** `gh` in `cwd`, no shell, bounded; any failure is a non-zero code. */
  gh: (args: string[], cwd: string) => Promise<RunResult>
  /** Run a command with text on standard input. */
  runWithInput: (argv: string[], input: string) => Promise<RunResult>
  /** Free bytes on the disk holding `path`; undefined when unknown. */
  freeBytes: (path: string) => Promise<number | undefined>
  lowDiskBytes: number
  log: (text: string) => void
  graceMs?: number
  /** Config files whose drivers are trusted; defaults to the user's global and system git config. */
  trustedConfig?: readonly string[]
  /** Test seam: runs between the last check and the rename when a build directory is removed. */
  beforeBuildRename?: (target: string) => void | Promise<void>
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
  const trusted = deps.trustedConfig ?? trustedConfigOrigins()
  let closed = false

  const gitAt = (v: Verified, args: string[]) => deps.run(["git", ...v.guard, "--git-dir", v.gitDir, "--work-tree", v.real, ...args])

  /** `-c` arguments that blank every repository-defined filter, textconv and diff command. Undefined: could not be made safe. */
  const guardFor = async (gitDir: string): Promise<string[] | undefined> => {
    const listed = await deps.run([
      "git",
      ...SAFE_GIT_ARGS,
      "--git-dir",
      gitDir,
      "config",
      "--null",
      "--show-origin",
      "--get-regexp",
      "^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(textconv|command))$",
    ])
    if (listed.code !== 0 && listed.code !== 1) return undefined
    const blank = neutralizers(listed.stdout, trusted)
    return blank === undefined ? undefined : [...SAFE_GIT_ARGS, ...blank]
  }

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
    const gitDir = verdict.pin.GIT_DIR as string
    const guard = await guardFor(gitDir)
    if (guard === undefined) return { ok: false, reason: "the repository defines a driver that cannot be disabled safely" }
    const listed = await deps.run(["git", ...guard, "--git-dir", own.commonDir, "worktree", "list", "--porcelain"])
    if (listed.code !== 0) return { ok: false, reason: "git worktree list failed" }
    const entries = parseListed(listed.stdout)
    const at = entries.findIndex((entry) => physical(entry.path) === real)
    if (at < 0) return { ok: false, reason: `git does not list ${real}` }
    if (at === 0) return { ok: false, reason: `${real} is the main worktree` }
    if (entries[at]?.locked) return { ok: false, reason: `${real} is locked` }
    return { ok: true, real, gitDir, guard }
  }

  const factsOf = async (lane: Lane, v: Verified): Promise<GitFacts | undefined> => {
    if (existsSync(join(v.real, ".gitmodules"))) return undefined
    const head = await gitAt(v, ["rev-parse", "--verify", "HEAD"])
    const status = await gitAt(v, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])
    const ahead = await gitAt(v, ["rev-list", "--count", `${lane.base}..HEAD`])
    if (head.code !== 0 || status.code !== 0 || ahead.code !== 0) return undefined
    let merged = false
    if (lane.target !== undefined) {
      merged = (await gitAt(v, ["merge-base", "--is-ancestor", "HEAD", `refs/heads/${lane.target}`])).code === 0
    }
    const contained = await gitAt(v, ["branch", "-r", "--contains", "HEAD"])
    return {
      head: head.stdout.trim(),
      dirty: status.stdout.trim() !== "",
      ahead: Number.parseInt(ahead.stdout.trim(), 10) || 0,
      merged,
      pushed: contained.code === 0 && contained.stdout.trim() !== "",
      busy: BUSY_MARKERS.some((name) => existsSync(join(v.gitDir, name))),
    }
  }

  /**
   * Pull request state for the lane's branch. MERGED and CLOSED count only when the pull request's
   * head is the commit the lane is at; a pull request for another head, or an answer gh could not
   * give, is "open" (keep) or undefined (try the patches).
   */
  const prState = async (lane: Lane, v: Verified, head: string): Promise<"merged" | "closed" | "open" | undefined> => {
    const result = await deps.gh(["pr", "view", lane.branch, "--json", "state,mergeCommit,headRefOid"], v.real)
    if (result.code !== 0) return undefined
    try {
      const reply = JSON.parse(result.stdout) as { state?: unknown; headRefOid?: unknown }
      if (reply.state === "OPEN") return "open"
      if (reply.state !== "MERGED" && reply.state !== "CLOSED") return undefined
      if (reply.headRefOid !== head) return "open"
      return reply.state === "MERGED" ? "merged" : "closed"
    } catch {
      return undefined
    }
  }

  const patchIds = async (v: Verified, text: string): Promise<string[] | undefined> => {
    const result = await deps.runWithInput(["git", ...v.guard, "patch-id", "--stable"], text)
    return result.code === 0 ? result.stdout.split("\n").map((line) => line.split(" ")[0] ?? "").filter((id) => id !== "") : undefined
  }

  /**
   * Whether the lane's commits already sit on the default branch under other hashes: `git cherry`
   * for one-to-one copies (only when the lane has no merge commits, which `cherry` skips), then the
   * patch-id of the combined diff against the patch-ids of the commits that landed since the merge
   * base (a squash). True only on a match; anything else is unknown.
   */
  const appliedUpstream = async (lane: Lane, v: Verified): Promise<boolean> => {
    const remote = await gitAt(v, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    const upstream = remote.code === 0 && remote.stdout.trim() !== "" ? remote.stdout.trim() : lane.target ? `refs/heads/${lane.target}` : undefined
    if (upstream === undefined) return false
    const merges = await gitAt(v, ["rev-list", "--merges", "--count", `${upstream}..HEAD`])
    if (merges.code === 0 && merges.stdout.trim() === "0") {
      const cherry = await gitAt(v, ["cherry", upstream, "HEAD"])
      if (cherry.code === 0) {
        const lines = cherry.stdout.split("\n").filter((line) => line !== "")
        if (lines.length > 0 && lines.every((line) => line.startsWith("-"))) return true
      }
    }
    const base = await gitAt(v, ["merge-base", upstream, "HEAD"])
    if (base.code !== 0) return false
    const mine = await gitAt(v, ["diff", "--no-ext-diff", "--no-textconv", base.stdout.trim(), "HEAD"])
    if (mine.code !== 0 || mine.stdout === "") return false
    const landed = await gitAt(v, ["log", "-p", "--no-ext-diff", "--no-textconv", "--no-merges", "--format=commit %H", "-n", "200", `${base.stdout.trim()}..${upstream}`])
    if (landed.code !== 0 || landed.stdout === "") return false
    const [ownId] = (await patchIds(v, mine.stdout)) ?? []
    const theirs = await patchIds(v, landed.stdout)
    return ownId !== undefined && theirs?.includes(ownId) === true
  }

  /** Remember a "not done" answer for a while, so a lane that stays open does not cost a gh call per trigger. */
  const doneCache = new Map<string, { at: number; head: string }>()
  const DONE_RECHECK_MS = 5 * 60_000

  const detectDone = async (lane: Lane, v: Verified, head: string): Promise<"merged" | "closed" | undefined> => {
    const cached = doneCache.get(lane.child)
    if (cached && cached.head === head && deps.now() - cached.at < DONE_RECHECK_MS) return undefined
    const state = await prState(lane, v, head)
    if (state === "merged" || state === "closed") return state
    if (state === undefined && (await appliedUpstream(lane, v))) return "merged"
    doneCache.set(lane.child, { at: deps.now(), head })
    return undefined
  }

  /** Delete each allow-listed build directory that is a real ignored directory with nothing tracked in it. */
  const freeBuildDirs = async (v: Verified): Promise<number> => {
    const before = await deps.freeBytes(v.real)
    for (const rel of BUILD_DIRS) {
      const target = join(v.real, rel)
      try {
        const stat = lstatSync(target)
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue
      } catch {
        continue
      }
      const ignored = await gitAt(v, ["check-ignore", "-q", "--", rel])
      const tracked = await gitAt(v, ["ls-files", "--", rel])
      if (ignored.code !== 0 || tracked.code !== 0 || tracked.stdout.trim() !== "") continue
      await removeBuildDir(v.real, rel, deps.beforeBuildRename)
    }
    const after = await deps.freeBytes(v.real)
    return before !== undefined && after !== undefined ? Math.max(0, after - before) : 0
  }

  const clean = (child: string): Promise<CleanupOutcome> =>
    deps.withLane(child, async () => {
      if (closed) return { action: "untouched", reason: "cleanup is shutting down" }
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
      const git = await factsOf(lane, v)
      // A lane whose commits are not in the target may still be finished: ask the pull request, then the patches.
      if (git && git.ahead > 0 && !git.merged && !git.dirty && !git.busy) {
        const done = await detectDone(lane, v, git.head)
        if (done) git.done = done
      }
      const room = deps.lowDiskBytes > 0 ? await deps.freeBytes(v.real) : undefined
      const lowDisk = room !== undefined && room < deps.lowDiskBytes
      const inactiveMs = owner.lastActivity === undefined ? 0 : Math.max(0, deps.now() - owner.lastActivity)
      const decision = decideCleanup({ owner: owner.presence, parent: parent.presence, inactiveMs, graceMs, lowDisk, git })
      if (decision.kind === "untouched") return { action: "untouched", reason: decision.reason }

      if (decision.kind === "remove") {
        if (git === undefined) return { action: "untouched", reason: "the lane's git state could not be read" }
        const claim = deps.fence.claim(v.real)
        if (claim === undefined) return { action: "untouched", reason: "a spawn or resume is using the worktree" }
        try {
          // Everything the decision rested on is checked again, bound to the commit it was made for.
          const again = await verify(lane)
          if (!again.ok || again.real !== v.real) return { action: "untouched", reason: "the lane changed while cleanup was deciding" }
          const facts = await factsOf(lane, again)
          const ownerNow = await deps.presence(lane.child)
          const parentNow = await deps.presence(lane.parent)
          const inside = await deps.runningInside(lane, again.real)
          if (facts === undefined || facts.head !== git.head || facts.ahead !== git.ahead || facts.merged !== git.merged || facts.pushed !== git.pushed) {
            return { action: "untouched", reason: "the lane changed while cleanup was deciding" }
          }
          if (inside !== "none") return { action: "untouched", reason: "a live session works inside the worktree" }
          const final = decideCleanup({
            owner: ownerNow.presence,
            parent: parentNow.presence,
            inactiveMs,
            graceMs,
            lowDisk,
            git: { ...facts, ...(git.done === undefined ? {} : { done: git.done }) },
          })
          if (final.kind !== "remove" || final.branch !== decision.branch) return { action: "untouched", reason: "the lane changed while cleanup was deciding" }
          try {
            await deps.removeWorktree(lane, again.real, again.guard)
          } catch (error) {
            deps.log(`subagent-worktree: could not remove ${again.real}: ${error instanceof Error ? error.message : String(error)}`)
            return { action: "untouched", reason: "the worktree could not be removed" }
          }
          if (existsSync(again.real)) return { action: "untouched", reason: "the worktree is still there after removal" }
          await deps.save({ ...lane, state: "removed" })
          let branchDeleted = false
          if (decision.branch === "delete") {
            branchDeleted = (await deps.run(["git", ...again.guard, "--git-dir", lane.ownership.commonDir, "branch", "--quiet", "-d", lane.branch])).code === 0
          }
          return { action: "removed", reason: decision.reason, branchDeleted }
        } finally {
          claim()
        }
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
      if (closed) return { swept: 0, skipped: "cleanup is shutting down" }
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
        let swept = 0
        for (const lane of todo) {
          if (closed) break
          await clean(lane.child)
          swept++
        }
        return { swept }
      } finally {
        await deps.storage.remove(LEASE_KEY)
      }
    })().finally(() => {
      flight = undefined
    })
    return flight
  }

  /** Stop starting work; a lane being cleaned finishes its current step. */
  const close = () => {
    closed = true
  }

  return { clean, sweep, verify, close }
}

export type Cleanup = ReturnType<typeof createCleanup>
