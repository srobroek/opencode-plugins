/**
 * Cheap, synchronous checks for what kind of project a directory holds, for gating
 * plugin features on project markers. Reads a bounded set of files; never recurses.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** Largest file `readSmall` reads; bigger files count as unreadable. */
export const MAX_MARKER_BYTES = 512 * 1024

export function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** A file's text when it exists and is at most `MAX_MARKER_BYTES`, else undefined. */
export function readSmall(path: string): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return undefined
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** Names of the entries of `directory`, or none when it cannot be read. */
export function entries(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

/** Whether `directory` has an entry with one of `names`. */
export function hasAny(directory: string, names: readonly string[]): boolean {
  return names.some((name) => exists(join(directory, name)))
}

/** Every dependency name in `package.json` at `directory` (all dependency fields). */
export function packageDependencies(directory: string): string[] {
  const text = readSmall(join(directory, "package.json"))
  if (text === undefined) return []
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>
    const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    return fields.flatMap((field) => {
      const value = manifest[field]
      return typeof value === "object" && value !== null ? Object.keys(value) : []
    })
  } catch {
    return []
  }
}

/** `directory` plus its workspace-style children (`apps/*`, `packages/*` and similar), one level deep. */
export function packageDirectories(directory: string, groups: readonly string[] = ["apps", "packages", "web"]): string[] {
  const result = [directory]
  for (const group of groups) {
    const parent = join(directory, group)
    if (exists(join(parent, "package.json"))) result.push(parent)
    for (const name of entries(parent)) {
      const child = join(parent, name)
      if (exists(join(child, "package.json"))) result.push(child)
    }
  }
  return result
}
