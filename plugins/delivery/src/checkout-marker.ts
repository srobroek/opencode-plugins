/**
 * Who owns a checkout, decided from plain filesystem reads.
 *
 * A checkout of another repository is untrusted: even an object-only Git command run
 * inside it can start programs its config names. So before any Git process runs in a
 * target, its `.git` entry is read here, without following links or blocking, and the
 * target is accepted only when it provably belongs to the session repository.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"

/** `.git` entries and `commondir` files are one short line; anything bigger is not read. */
const MAX_MARKER_BYTES = 64 * 1024

/**
 * - `absent`: nothing is at the path.
 * - `unreadable`: something is there, but it is not a small regular non-symlink file
 *   (a link, FIFO, device or huge file), or reading it failed.
 *
 * Mirrors the bounded read the beads plugin uses for ledger files; delivery cannot import
 * from beads, and this copy opens with `O_NOFOLLOW | O_NONBLOCK` after an `lstat` so a FIFO
 * or a link to one is refused without blocking.
 */
export type BoundedRead = { kind: "absent" } | { kind: "unreadable" } | { kind: "text"; text: string }

export function readBounded(path: string): BoundedRead {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) return { kind: "unreadable" }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_MARKER_BYTES) return { kind: "unreadable" }
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return { kind: "text", text: buffer.toString("utf8", 0, offset) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export type MarkerState = "same" | "foreign" | "unsafe" | "absent"

function physical(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** The physical `gitdir` a `.git` file names, or null. */
function gitDirectoryOf(checkout: string, marker: string): string | null {
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(marker)
  return match?.[1] === undefined ? null : physical(resolve(checkout, match[1].trim()))
}

/**
 * Classify `checkout` against the session repository's physical common directory.
 *
 * - `same`: a `.git` directory that is the common directory, or a regular `gitdir:` file
 *   naming a directory directly under `<common>/worktrees/` (or the common directory
 *   itself) whose `commondir` resolves to the common directory.
 * - `foreign`: it provably names another repository.
 * - `unsafe`: a symlink, FIFO or other non-regular entry, an unreadable or malformed
 *   marker, or a gitdir the session repository does not own.
 * - `absent`: no `.git` entry (a path that is not a checkout).
 */
export function inspectCheckoutMarker(checkout: string, commonDir: string): MarkerState {
  const entry = join(checkout, ".git")
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(entry)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unsafe"
  }
  if (stat.isSymbolicLink()) return "unsafe"
  if (stat.isDirectory()) return physical(entry) === commonDir ? "same" : "foreign"
  if (!stat.isFile()) return "unsafe"
  const marker = readBounded(entry)
  if (marker.kind !== "text") return "unsafe"
  const gitDir = gitDirectoryOf(checkout, marker.text)
  if (gitDir === null) return "unsafe"
  let claimed = gitDir
  const commondir = readBounded(join(gitDir, "commondir"))
  if (commondir.kind === "unreadable") return "unsafe"
  if (commondir.kind === "text") {
    const resolved = physical(resolve(gitDir, commondir.text.trim()))
    if (resolved === null) return "unsafe"
    claimed = resolved
  }
  if (claimed !== commonDir) return "foreign"
  if (gitDir === commonDir) return "same"
  const worktrees = physical(join(commonDir, "worktrees"))
  return worktrees !== null && physical(join(gitDir, "..")) === worktrees ? "same" : "unsafe"
}
