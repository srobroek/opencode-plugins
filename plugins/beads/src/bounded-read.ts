/**
 * Bounded reads of repository-controlled files.
 *
 * A ledger's `metadata.json` and `config.yaml` live in the working tree, so a commit can
 * make them a symlink to `/dev/zero`, a FIFO or a huge file. Reading one unbounded
 * exhausts memory or stalls the host, so every ledger read goes through here.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"

/** Ledger metadata is a few lines; anything bigger is not read. */
export const MAX_LEDGER_FILE_BYTES = 64 * 1024

/**
 * - `absent`: nothing is at the path.
 * - `unreadable`: something is there, but it is not a small regular non-symlink file
 *   (or reading it failed), so its content cannot be trusted or even read safely.
 */
export type BoundedRead = { kind: "absent" } | { kind: "unreadable" } | { kind: "text"; text: string }

export function readBounded(path: string): BoundedRead {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) return { kind: "unreadable" }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_LEDGER_FILE_BYTES) return { kind: "unreadable" }
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

/** The text of a small regular file, or undefined for anything else. Diagnostics only. */
export function readSmallRegularFile(path: string): string | undefined {
  const read = readBounded(path)
  return read.kind === "text" ? read.text : undefined
}
