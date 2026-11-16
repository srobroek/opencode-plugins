import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileValue } from "./answers.ts"

/** Where uploads are written. Private to the user: a 0700 directory holding 0600 files. */
export const uploadRoot = (base = tmpdir()) => path.join(base, "parley")

const safe = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, "_") || "round"

/**
 * Writes an upload to disk and returns its path, or undefined when it has no contents. Files live under
 * their round, so they can be removed with it. They stay until `removeUploads` runs for the round, which
 * parley does when it prunes the closed round (at least 30 minutes after it closed), never earlier: the
 * agent reads them on a later turn.
 */
export function saveUpload(file: FileValue, roundID: string | undefined, base = tmpdir()): string | undefined {
  if (file.data === undefined) return undefined
  const root = uploadRoot(base)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const dir = path.join(root, safe(roundID ?? crypto.randomUUID()))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, path.basename(file.name))
  writeFileSync(target, Buffer.from(file.data, "base64"), { mode: 0o600 })
  chmodSync(target, 0o600)
  return target
}

/** Removes the files a round's uploads were written to. */
export function removeUploads(roundID: string, base = tmpdir()) {
  rmSync(path.join(uploadRoot(base), safe(roundID)), { recursive: true, force: true })
}
