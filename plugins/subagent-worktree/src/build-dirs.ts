/**
 * Freeing build and dependency directories in a lane whose owner is gone. Only an allow-listed
 * set of directories, only when git ignores them and tracks nothing in them, and never through
 * a link: every path component is checked with `lstat`, remembered by inode, and checked again
 * before the directory is renamed aside (a rename never follows its last component) and deleted.
 * A component swapped for a link in between puts the directory back and deletes nothing.
 */

import { lstatSync, renameSync } from "node:fs"
import { rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { physical } from "@srobroek/opencode-lib/checkout-marker"
import { SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git"
import type { Runner } from "./git.ts"

/** An owner gone this long may have its lane's build directories freed. */
export const BUILD_GRACE_MS = 30 * 60_000

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

/** Whether free space is below a non-zero threshold; an unknown size never counts as low. */
export function isLowDisk(freeBytes: number | undefined, thresholdBytes: number): boolean {
  return thresholdBytes > 0 && freeBytes !== undefined && freeBytes < thresholdBytes
}

/**
 * Remove one directory (relative to `root`, a canonical path) without following a link anywhere on
 * its path. `beforeRename` is a test seam that runs between the last check and the rename.
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
 * Free each allow-listed directory of the worktree at `root` that is a real directory, ignored by git,
 * with no tracked file in it. Returns the relative paths freed. Any git failure skips that directory.
 */
export async function freeBuildDirs(
  run: Runner,
  root: string,
  beforeRename?: (target: string) => void | Promise<void>,
): Promise<string[]> {
  const freed: string[] = []
  for (const rel of BUILD_DIRS) {
    try {
      const stat = lstatSync(join(root, rel))
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue
    } catch {
      continue
    }
    const ignored = await run(["git", ...SAFE_GIT_ARGS, "-C", root, "check-ignore", "-q", "--", rel])
    const tracked = await run(["git", ...SAFE_GIT_ARGS, "-C", root, "ls-files", "--", rel])
    if (ignored.code !== 0 || tracked.code !== 0 || tracked.stdout.trim() !== "") continue
    if (await removeBuildDir(root, rel, beforeRename)) freed.push(rel)
  }
  return freed
}
