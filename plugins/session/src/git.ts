/** Read-only git helpers, ported from omp-plugins `session/extensions/store.ts`. */

import { execFile } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** A git read, off the event loop, with `GIT_OPTIONAL_LOCKS=0` so it never takes index.lock. */
export async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
    return stdout
  } catch {
    return null
  }
}

export interface Worktree {
  path: string
  head: string
  branch: string
  detached: boolean
  isMain: boolean
}

/** Parse `git worktree list --porcelain`: main first, prunable entries dropped. */
export function parseWorktrees(out: string, exists: (path: string) => boolean = existsSync): Worktree[] {
  const parsed: Array<Worktree & { prunable: boolean }> = []
  let current: (Worktree & { prunable: boolean }) | null = null
  for (const line of out.split("\n")) {
    if (line.trim() === "") {
      if (current) parsed.push(current)
      current = null
      continue
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), head: "", branch: "", detached: false, isMain: false, prunable: false }
      continue
    }
    if (!current) continue
    if (line.startsWith("HEAD ")) current.head = line.slice(5)
    else if (line.startsWith("branch ")) {
      const ref = line.slice(7)
      current.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref
    } else if (line === "detached") current.detached = true
    else if (line.startsWith("prunable")) current.prunable = true
  }
  if (current) parsed.push(current)
  const live: Worktree[] = []
  parsed.forEach((worktree, index) => {
    if (worktree.prunable || !exists(worktree.path)) return
    const { prunable: _, ...rest } = worktree
    live.push({ ...rest, isMain: index === 0 })
  })
  return live
}

/** Live worktrees of the repository containing `directory`; empty outside a repository. */
export async function listWorktrees(directory: string): Promise<Worktree[]> {
  const out = await git(["-C", directory, "worktree", "list", "--porcelain"])
  return out === null ? [] : parseWorktrees(out)
}

/** The branch checked out in `directory` now, or undefined. */
export async function currentBranch(directory: string): Promise<string | undefined> {
  const out = await git(["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"])
  const branch = out?.trim()
  return branch ? branch : undefined
}

/**
 * Every spelling of `path` a recorded directory might use: on macOS a session may
 * record `/tmp/x` while git answers `/private/tmp/x`.
 */
export function pathKeys(path: string): string[] {
  const keys = [path.replace(/\/+$/, "")]
  try {
    const resolved = realpathSync(path).replace(/\/+$/, "")
    if (resolved !== keys[0]) keys.push(resolved)
  } catch {
    // The directory is gone; the literal spelling is all there is.
  }
  return keys
}

/** Every accepted spelling of every worktree path, or of `fallback` outside a repository. */
export function acceptedPaths(worktrees: readonly Worktree[], fallback: string): Set<string> {
  const paths = worktrees.length > 0 ? worktrees.map((worktree) => worktree.path) : [fallback]
  return new Set(paths.flatMap((path) => pathKeys(path)))
}

/** The worktree a directory belongs to (exact match on any spelling). */
export function worktreeFor(worktrees: readonly Worktree[], directory: string): Worktree | undefined {
  const keys = new Set(pathKeys(directory))
  return worktrees.find((worktree) => pathKeys(worktree.path).some((key) => keys.has(key)))
}

/** Short label: the basename, `(main)` for the main checkout. */
export function worktreeLabel(worktree: Worktree | undefined, directory: string): string {
  if (!worktree) return basename(directory) || directory || "?"
  const name = basename(worktree.path) || worktree.path
  return worktree.isMain ? `${name} (main)` : name
}
