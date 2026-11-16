import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileValue } from "./answers.ts"

/** Upload files outlive their round record: they are removed this long after the round closed. */
export const UPLOAD_TTL_MS = 24 * 60 * 60_000
/** A round directory without a close marker (its round was never seen closing) goes after this long untouched. */
export const UNMARKED_TTL_MS = 2 * UPLOAD_TTL_MS
/** Written into a round's upload directory when the round closes: the time it closed, in ms. */
export const CLOSED_MARKER = ".closed"

/** Where uploads are written. Private to the user: 0700 directories holding 0600 files. */
export const uploadRoot = (base = tmpdir()) => path.join(base, "parley")

const safe = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, "_") || "round"
const roundDir = (roundID: string, base: string) => path.join(uploadRoot(base), safe(roundID))

const privateDir = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/**
 * Writes an upload to disk and returns its path, or undefined when it has no contents. Each upload gets
 * its own directory under its round, so two files with the same name never overwrite each other; the
 * file keeps its original name. The files stay until `sweepUploads` finds the round closed for longer
 * than `UPLOAD_TTL_MS`, so an agent can read them on a later turn.
 */
export function saveUpload(file: FileValue, roundID: string | undefined, base = tmpdir()): string | undefined {
  if (file.data === undefined) return undefined
  privateDir(uploadRoot(base))
  const round = roundDir(roundID ?? crypto.randomUUID(), base)
  privateDir(round)
  const dir = path.join(round, crypto.randomUUID())
  privateDir(dir)
  const target = path.join(dir, path.basename(file.name) || "upload")
  writeFileSync(target, Buffer.from(file.data, "base64"), { mode: 0o600 })
  chmodSync(target, 0o600)
  return target
}

/** Removes the directory holding one private copy (its unique upload directory). Only paths inside the upload root; never throws. */
export function removeUpload(stored: string, base = tmpdir()) {
  const root = uploadRoot(base)
  const dir = path.dirname(path.resolve(stored))
  if (!dir.startsWith(root + path.sep) || path.dirname(dir) === root) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The sweeper removes it later.
  }
}

/**
 * Reads a private copy back as base64. Only paths inside the upload root are read, and a copy that is
 * gone (swept, or a missing file) is undefined. Never throws.
 */
export function readUpload(stored: string, base = tmpdir()): string | undefined {
  const root = uploadRoot(base)
  const target = path.resolve(stored)
  if (!target.startsWith(root + path.sep)) return undefined
  try {
    return readFileSync(target).toString("base64")
  } catch {
    return undefined
  }
}

/** Records when a round closed, once, if it has uploads. Its files are kept `UPLOAD_TTL_MS` from then. */
export function markClosed(roundID: string, at: number, base = tmpdir()) {
  const dir = roundDir(roundID, base)
  const marker = path.join(dir, CLOSED_MARKER)
  if (!existsSync(dir) || existsSync(marker)) return
  writeFileSync(marker, String(at), { mode: 0o600 })
}

const closedAt = (dir: string): number | undefined => {
  try {
    const value = Number(readFileSync(path.join(dir, CLOSED_MARKER), "utf8"))
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Removes the upload directories of rounds closed more than `UPLOAD_TTL_MS` ago, whether or not their
 * round record still exists, and unmarked ones untouched for `UNMARKED_TTL_MS`. Never throws.
 */
export function sweepUploads(now: number, base = tmpdir()) {
  const root = uploadRoot(base)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    const dir = path.join(root, name)
    try {
      const closed = closedAt(dir)
      const expired =
        closed === undefined ? now - statSync(dir).mtimeMs > UNMARKED_TTL_MS : now - closed > UPLOAD_TTL_MS
      if (expired) rmSync(dir, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to read: the next sweep tries again.
    }
  }
}
