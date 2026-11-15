/**
 * Who owns a checkout, decided from plain filesystem reads.
 *
 * A checkout of another repository is untrusted: even an object-only Git command run
 * inside it can start programs its config names. So before any Git process runs in a
 * target, its `.git` entry is read here, without following links or blocking, and the
 * target is accepted only when it provably belongs to the session repository.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"

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

/**
 * The physical path of `path`, or null. `realpathSync.native` asks the OS to resolve
 * each component in turn, so a `..` that follows a symlink is resolved through the link
 * as Git would; the JavaScript `realpathSync` normalizes `..` lexically first and would
 * not.
 */
function physical(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * A path value read from a Git marker file, resolved the way Git resolves it: an
 * absolute value as it stands, a relative one under `base`, spelled by plain
 * concatenation so no `..` is normalized before the OS follows the links.
 */
function physicalFrom(base: string, value: string): string | null {
  return physical(value.startsWith("/") ? value : `${base}/${value}`)
}

/**
 * What Git reads from a `gitdir: <path>` file: the text after exactly `gitdir: `, up
 * to the record terminator. Leading blanks are part of the path (`gitdir:  /abs` names a
 * relative path beginning with a space), so nothing is trimmed from the front. Null for
 * anything else, including a value with an embedded line break.
 */
export function gitFileValue(text: string): string | null {
  if (!text.startsWith("gitdir: ")) return null
  const value = text.slice("gitdir: ".length).replace(/\r?\n$/, "")
  return value === "" || /[\r\n]/.test(value) ? null : value
}

/** What a `commondir` file holds: its single line, minus the record terminator and nothing else. */
export function commondirValue(text: string): string | null {
  const value = text.replace(/\r?\n$/, "")
  return value === "" || /[\r\n]/.test(value) ? null : value
}

/**
 * The environment that pins Git to a verified checkout: with `GIT_DIR`, `GIT_WORK_TREE`
 * and `GIT_COMMON_DIR` set, Git never rediscovers the repository through the `.git`
 * marker, so swapping that marker after verification cannot redirect it.
 */
export type GitPin = Readonly<Record<string, string>>

export type CheckoutVerdict = { state: Exclude<MarkerState, "same"> } | { state: "same"; pin: GitPin }

/**
 * Classify `checkout` against the session repository's physical common directory.
 *
 * - `same`: a `.git` directory that is the common directory, or a regular `gitdir:` file
 *   naming a directory directly under `<common>/worktrees/` (or the common directory
 *   itself) whose `commondir` resolves to the common directory. Carries the pin built
 *   from exactly what was read.
 * - `foreign`: it provably names another repository.
 * - `unsafe`: a symlink, FIFO or other non-regular entry, an unreadable or malformed
 *   marker, or a gitdir the session repository does not own.
 * - `absent`: no `.git` entry (a path that is not a checkout).
 */
export function verifyCheckout(checkout: string, commonDir: string): CheckoutVerdict {
  const entry = join(checkout, ".git")
  const workTree = physical(checkout)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(entry)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { state: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unsafe" }
  }
  if (workTree === null || stat.isSymbolicLink()) return { state: "unsafe" }
  const pin = (gitDir: string): GitPin => ({ GIT_DIR: gitDir, GIT_WORK_TREE: workTree, GIT_COMMON_DIR: commonDir })
  if (stat.isDirectory()) {
    const real = physical(entry)
    return real === commonDir ? { state: "same", pin: pin(commonDir) } : { state: real === null ? "unsafe" : "foreign" }
  }
  if (!stat.isFile()) return { state: "unsafe" }
  const marker = readBounded(entry)
  if (marker.kind !== "text") return { state: "unsafe" }
  const named = gitFileValue(marker.text)
  const gitDir = named === null ? null : physicalFrom(checkout, named)
  if (gitDir === null) return { state: "unsafe" }
  let claimed = gitDir
  const commondir = readBounded(join(gitDir, "commondir"))
  if (commondir.kind === "unreadable") return { state: "unsafe" }
  if (commondir.kind === "text") {
    const value = commondirValue(commondir.text)
    const resolved = value === null ? null : physicalFrom(gitDir, value)
    if (resolved === null) return { state: "unsafe" }
    claimed = resolved
  }
  if (claimed !== commonDir) return { state: "foreign" }
  if (gitDir === commonDir) return { state: "same", pin: pin(gitDir) }
  const worktrees = physical(join(commonDir, "worktrees"))
  return worktrees !== null && dirname(gitDir) === worktrees ? { state: "same", pin: pin(gitDir) } : { state: "unsafe" }
}

/** The state alone, for callers that only choose a refusal. */
export function inspectCheckoutMarker(checkout: string, commonDir: string): MarkerState {
  return verifyCheckout(checkout, commonDir).state
}
