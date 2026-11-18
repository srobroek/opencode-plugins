/**
 * Freeing build and dependency directories in a lane whose owner is gone. Only an allow-listed
 * set of directories, only when git ignores them and tracks nothing in them, and never through
 * a link: every path component is checked with `lstat`, remembered by inode, and checked again
 * before the directory is renamed aside (a rename never follows its last component). The caller
 * deletes the detached directory later, outside its lock, after its inode is checked once more.
 * A component swapped for a link in between puts the directory back and deletes nothing.
 *
 * The directory is renamed into the lane worktree's own git directory (`.git/worktrees/<name>/`),
 * never a sibling in the work tree: there git status and `git add -A` cannot see it while it is
 * deleted, a delete that fails leaves nothing in the tree, and `git worktree remove` or `prune`
 * deletes the leftover with the rest of that directory. A main checkout, whose git directory is
 * the one every worktree shares, and a git directory on another device are skipped.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
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

/** The directory, inside a worktree's own git directory, that build directories are moved into before they are deleted. */
export const TRASH_DIR = "opencode-trash"

/**
 * `<git-dir>/opencode-trash` for the linked worktree at `root` (canonical), created if missing; undefined
 * when it cannot be used safely: git fails, `root` is a main checkout (its git directory is the common
 * one), the git directory's `gitdir` file does not name `<root>/.git`, a path is not physical, or the
 * trash directory is a link or not a directory.
 */
export async function adminTrashDir(run: Runner, root: string): Promise<string | undefined> {
  const read = async (...args: string[]) => {
    const result = await run(["git", ...SAFE_GIT_ARGS, "-C", root, "rev-parse", "--path-format=absolute", ...args])
    return result.code === 0 ? result.stdout.trim() : undefined
  }
  const gitDir = await read("--absolute-git-dir")
  const common = await read("--git-common-dir")
  if (gitDir === undefined || common === undefined || gitDir === "" || common === "") return undefined
  try {
    const own = physical(gitDir)
    if (own === null || own !== gitDir || own === physical(common)) return undefined
    if (physical(readFileSync(join(own, "gitdir"), "utf8").trim()) !== join(root, ".git")) return undefined
    const trash = join(own, TRASH_DIR)
    mkdirSync(trash, { recursive: true })
    const stat = lstatSync(trash)
    if (stat.isSymbolicLink() || !stat.isDirectory() || physical(trash) !== trash) return undefined
    return trash
  } catch {
    return undefined
  }
}

/** A build directory renamed aside: still on disk under `trash`, no longer at its own name. */
export type Detached = { rel: string; trash: string; dev: number; ino: number }

/**
 * Rename one directory (relative to `root`, a canonical path) aside without following a link anywhere
 * on its path, and leave it there for {@link deleteDetached}. `beforeRename` is a test seam that runs
 * between the last check and the rename. Undefined when any check fails; then nothing moved.
 */
export async function detachBuildDir(
  root: string,
  rel: string,
  trashDir: string,
  beforeRename?: (target: string) => void | Promise<void>,
): Promise<Detached | undefined> {
  const inodes: Array<{ path: string; dev: number; ino: number }> = []
  let current = root
  try {
    for (const part of rel.split("/")) {
      current = join(current, part)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined
      inodes.push({ path: current, dev: stat.dev, ino: stat.ino })
    }
    const target = current
    if (physical(target) !== target) return undefined
    await beforeRename?.(target)
    for (const entry of inodes) {
      const stat = lstatSync(entry.path)
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== entry.dev || stat.ino !== entry.ino) return undefined
    }
    const last = inodes[inodes.length - 1]
    // A rename cannot cross devices; checked first so a git directory elsewhere is skipped, never copied.
    const home = lstatSync(trashDir)
    if (last === undefined || home.isSymbolicLink() || !home.isDirectory() || home.dev !== last.dev) return undefined
    const trash = join(trashDir, `${rel.replaceAll("/", "_")}-${Math.random().toString(36).slice(2, 10)}`)
    renameSync(target, trash)
    let sound = false
    try {
      const moved = lstatSync(trash)
      sound = last !== undefined && moved.isDirectory() && moved.dev === last.dev && moved.ino === last.ino && physical(trash) === trash
    } catch {}
    if (!sound) {
      try {
        renameSync(trash, target)
      } catch {}
      return undefined
    }
    return { rel, trash, dev: last.dev, ino: last.ino }
  } catch {
    return undefined
  }
}

/**
 * Delete a detached directory, after checking again that its path is still the directory that was
 * renamed there and not a link. False when that check or the delete fails; what is left stays in place.
 */
export async function deleteDetached(detached: Detached): Promise<boolean> {
  try {
    const stat = lstatSync(detached.trash)
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== detached.dev || stat.ino !== detached.ino) return false
    if (physical(detached.trash) !== detached.trash) return false
    await rm(detached.trash, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Detach and delete one directory at once; see {@link detachBuildDir}. */
export async function removeBuildDir(
  root: string,
  rel: string,
  trashDir: string,
  beforeRename?: (target: string) => void | Promise<void>,
): Promise<boolean> {
  const detached = await detachBuildDir(root, rel, trashDir, beforeRename)
  return detached !== undefined && (await deleteDetached(detached))
}

/**
 * Detach each allow-listed directory of the worktree at `root` that is a real directory, ignored by git,
 * with no tracked file in it, into {@link adminTrashDir}. Any git failure skips that directory; no usable
 * trash directory skips them all. Also returns what an earlier, interrupted delete left in the trash
 * directory. The caller deletes what it returns.
 */
export async function detachBuildDirs(
  run: Runner,
  root: string,
  beforeRename?: (target: string) => void | Promise<void>,
): Promise<Detached[]> {
  const trashDir = await adminTrashDir(run, root)
  if (trashDir === undefined) return []
  const detached: Detached[] = []
  for (const name of readdirSync(trashDir)) {
    const trash = join(trashDir, name)
    try {
      const stat = lstatSync(trash)
      if (!stat.isSymbolicLink() && stat.isDirectory()) detached.push({ rel: name, trash, dev: stat.dev, ino: stat.ino })
    } catch {}
  }
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
    const entry = await detachBuildDir(root, rel, trashDir, beforeRename)
    if (entry !== undefined) detached.push(entry)
  }
  return detached
}

/** Detach and delete every eligible directory; returns the relative paths freed. */
export async function freeBuildDirs(run: Runner, root: string, beforeRename?: (target: string) => void | Promise<void>): Promise<string[]> {
  const freed: string[] = []
  for (const entry of await detachBuildDirs(run, root, beforeRename)) if (await deleteDetached(entry)) freed.push(entry.rel)
  return freed
}
