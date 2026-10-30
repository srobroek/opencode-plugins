/**
 * Approval for project-file sources. A repository can ship `.opencode/claude-compat.json`
 * pointing at plugins inside itself, so opening a clone would otherwise run its hooks and
 * MCP servers. A project file loads nothing until the user approves a digest of the file
 * and of every source it names; the approval is remembered per digest, so any change asks
 * again.
 */

import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { expandHome, type Group, gitCachePath } from "./source.ts"

export const TRUST_ACTION = "claude_compat_trust"
export const TRUST_PREFIX = "trust/"
export const MAX_TRUST_FILES = 20_000
export const MAX_TRUST_BYTES = 64 * 1024 * 1024
/** Approved digests kept per file, newest last. */
export const MAX_REMEMBERED = 20

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

/**
 * A digest of every file under `dir` (paths, contents, symlink targets), including `.git`.
 * Throws when the tree is too large to verify.
 */
export function treeDigest(dir: string, limits = { files: MAX_TRUST_FILES, bytes: MAX_TRUST_BYTES }): string {
  const hash = createHash("sha256")
  let files = 0
  let bytes = 0
  const walk = (path: string, rel: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      const key = rel ? `${rel}/${name}` : name
      const stat = lstatSync(full)
      if (++files > limits.files) throw new Error(`${dir}: more than ${limits.files} files; too large to verify`)
      if (stat.isSymbolicLink()) hash.update(`L\0${key}\0${readlinkSync(full)}\0`)
      else if (stat.isDirectory()) {
        hash.update(`D\0${key}\0`)
        walk(full, key)
      } else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > limits.bytes) throw new Error(`${dir}: more than ${limits.bytes} bytes; too large to verify`)
        hash.update(`F\0${key}\0${stat.mode & 0o111 ? "x" : "-"}\0${sha256(readFileSync(full))}\0`)
      }
    }
  }
  walk(dir, "")
  return hash.digest("hex")
}

/**
 * The digest a project file is approved under: its text, then each source in order. A path
 * source contributes its canonical path and tree digest. Project-file git sources must
 * pin a full commit id: hashing their URL/ref does not fetch unapproved remote content.
 * An unreadable or oversized source cannot be approved.
 */
export function projectFileDigest(group: Group, project: string): string {
  const parts = [`file\0${group.projectFile?.text ?? ""}`]
  for (const source of group.sources) {
    if ("git" in source) {
      if (!/^[0-9a-f]{40}$/i.test(source.ref)) throw new Error("Project-file git sources must pin a full commit SHA")
      parts.push(`git\0${source.git}\0${source.ref}`)
      const cached = gitCachePath(source)
      if (existsSync(cached)) parts.push(`checkout\0${realpathSync(cached)}\0${treeDigest(cached)}`)
    }
    else {
      const path = realpathSync(resolve(project, expandHome(source.path)))
      parts.push(`path\0${source.path}\0${path}\0${treeDigest(path)}`)
    }
  }
  return sha256(parts.join("\0\0"))
}

/** The permission resource the approval asks for: the canonical file path and its digest. */
export function trustResource(path: string, digest: string): string {
  return `${path}#sha256:${digest}`
}

type Storage = { get: (key: string) => Promise<unknown>; set: (key: string, value: never) => Promise<void> }
const keyFor = (path: string) => `${TRUST_PREFIX}${sha256(path)}`

function remembered(value: unknown, path: string): string[] {
  const record = value as { path?: unknown; digests?: unknown } | undefined
  if (record?.path !== path || !Array.isArray(record.digests)) return []
  return record.digests.filter((digest): digest is string => typeof digest === "string")
}

export async function isTrusted(storage: Storage, path: string, digest: string): Promise<boolean> {
  return remembered(await storage.get(keyFor(path)), path).includes(digest)
}

export async function rememberTrust(storage: Storage, path: string, digest: string): Promise<void> {
  const digests = remembered(await storage.get(keyFor(path)), path).filter((known) => known !== digest)
  digests.push(digest)
  await storage.set(keyFor(path), { path, digests: digests.slice(-MAX_REMEMBERED) } as never)
}
