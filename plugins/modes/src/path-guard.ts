/**
 * Segment-aware write guard for the `debug` agent.
 *
 * Permission globs let `*` span `/`, so a pattern like worktree, star, debug-star also matches a debug-star directory
 * nested inside another lane. This guard decides on path segments after resolving symlinks:
 * a write is allowed only inside `~/.opencode/debug/`, or inside `<worktree root>/<hash>/debug-<slug>/`,
 * and never inside the directory the session started in.
 */

import { lstatSync, readlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { WRITE_TOOLS, writeTargets } from "@srobroek/opencode-lib/tool-targets"

export type PathGuardOptions = {
  /** The user's home directory. Defaults to `os.homedir()`. */
  home?: string
  /** The directory the session started in, which is never writable. */
  startDir: string
}

const MAX_LINKS = 40

/**
 * The absolute path with every symlink resolved, walking it one segment at a time with `lstat`.
 * A dangling symlink is followed through `readlink` (relative targets resolve from the link's own
 * directory); only a name with nothing at all behind it counts as missing, and the rest of the path
 * is then taken as written. Any other error, or too many links, throws so the caller fails closed.
 */
export function canonical(path: string): string {
  const pending = resolve(path).split(sep).filter((segment) => segment !== "")
  let current: string = sep
  let links = 0
  while (pending.length > 0) {
    const segment = pending.shift() as string
    if (segment === ".") continue
    if (segment === "..") {
      current = dirname(current)
      continue
    }
    const next = join(current, segment)
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return resolve(join(next, ...pending))
    }
    if (!stats.isSymbolicLink()) {
      current = next
      continue
    }
    if (++links > MAX_LINKS) throw new Error(`too many symbolic links resolving ${path}`)
    const target = readlinkSync(next)
    if (isAbsolute(target)) current = sep
    pending.unshift(...target.split(sep).filter((part) => part !== ""))
  }
  return current
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** Why a debug write to `target` is refused, or undefined when it is allowed. */
export function checkDebugWrite(target: string, options: PathGuardOptions): string | undefined {
  try {
    return checkResolved(target, options)
  } catch (error) {
    return `${target} could not be resolved (${(error as Error).message}), so the write is refused`
  }
}

function checkResolved(target: string, options: PathGuardOptions): string | undefined {
  const home = canonical(options.home ?? homedir())
  const start = canonical(options.startDir)
  const path = canonical(isAbsolute(target) ? target : resolve(start, target))
  if (path === start || inside(path, start)) return `${target} is inside the directory this session started in`
  if (inside(path, join(home, ".opencode", "debug"))) return undefined
  const worktrees = join(home, ".local", "share", "opencode", "worktree")
  if (inside(path, worktrees)) {
    const [hash, lane, ...rest] = relative(worktrees, path).split(sep)
    if (hash !== undefined && lane !== undefined && /^debug-.+/.test(lane) && rest.length > 0) return undefined
  }
  return `${target} is outside a debug-* scratch worktree and the debug ledger directory`
}

/** `checkDebugWrite` for an edit, write or patch call by the `debug` agent. */
export function guardDebugWrite(tool: string, input: unknown, agent: string, options: PathGuardOptions): string | undefined {
  if (agent !== "debug" || !WRITE_TOOLS.has(tool)) return undefined
  const targets = writeTargets(tool, input)
  if (targets.length === 0) return "the write has no readable target path, so it cannot be checked"
  for (const target of targets) {
    const reason = checkDebugWrite(target, options)
    if (reason !== undefined) return reason
  }
  return undefined
}
