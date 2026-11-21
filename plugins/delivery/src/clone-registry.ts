/**
 * The clones a session landed in, kept on disk so the turn-end retry and gc can find the
 * receipts of a repository other than the session's, also after a restart.
 *
 * One file per session under the receipts root: `<receipts root>/.clones/<sessionKey>.json`
 * holds `{ version: 1, clones: [{ commonDir, root, key, repo, receiptIds, addedAt }] }`. A
 * receipt is filed under the target repository's key; this registry only names which ones the
 * session still has to clean up. Claims, holds, denials and landing records of that landing
 * live in the target's git common directory, never here.
 *
 * Reads are strict (an unreadable file is reported, never treated as empty) and every write
 * is a read-modify-write under the same on-disk lease the other coordination writes take.
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type LockOptions, lockedWrite } from "@srobroek/opencode-lib/worktree-locks"
import { receiptDirectory } from "./landing-receipt.ts"

export type CloneEntry = {
  /** The target repository's git common directory (physical path). */
  commonDir: string
  /** The target repository's canonical checkout root. */
  root: string
  /** The key the target's receipts are filed under. */
  key: string
  /** `<owner>/<name>` of the target repository. */
  repo: string
  receiptIds: string[]
  addedAt: number
}

export type CloneRegistry = { version: 1; clones: CloneEntry[] }

export type RegistryRead = { kind: "missing" } | { kind: "unreadable" } | { kind: "present"; value: CloneRegistry }

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The directory the registries live in. */
export function cloneRegistryDirectory(env: NodeJS.ProcessEnv): string {
  return join(receiptDirectory(env), ".clones")
}

/** The file name stem for a session: a hash, so no session id can name another path. */
export function sessionKey(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 32)
}

export function cloneRegistryFile(env: NodeJS.ProcessEnv, sessionID: string): string {
  return join(cloneRegistryDirectory(env), `${sessionKey(sessionID)}.json`)
}

/** A registry from parsed JSON, or undefined when any part has the wrong shape. Pure. */
export function parseRegistry(value: unknown): CloneRegistry | undefined {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.clones)) return undefined
  const clones: CloneEntry[] = []
  for (const raw of value.clones) {
    if (!isObject(raw)) return undefined
    const { commonDir, root, key, repo, receiptIds, addedAt } = raw
    if (typeof commonDir !== "string" || commonDir === "" || typeof root !== "string" || root === "") return undefined
    if (typeof key !== "string" || typeof repo !== "string" || typeof addedAt !== "number") return undefined
    if (!Array.isArray(receiptIds) || receiptIds.some((id) => typeof id !== "string" || id === "")) return undefined
    clones.push({ commonDir, root, key, repo, receiptIds: receiptIds as string[], addedAt })
  }
  return { version: 1, clones }
}

/** The registry with `entry`'s receipts added to its clone (matched by common directory). Pure. */
export function withReceipts(registry: CloneRegistry, entry: CloneEntry): CloneRegistry {
  const existing = registry.clones.find((clone) => clone.commonDir === entry.commonDir)
  if (existing === undefined) return { version: 1, clones: [...registry.clones, { ...entry, receiptIds: [...new Set(entry.receiptIds)] }] }
  return {
    version: 1,
    clones: registry.clones.map((clone) =>
      clone === existing ? { ...clone, root: entry.root, key: entry.key, repo: entry.repo, receiptIds: [...new Set([...clone.receiptIds, ...entry.receiptIds])] } : clone,
    ),
  }
}

/** The registry without these receipts of one clone; a clone left with none is dropped. Pure. */
export function withoutReceipts(registry: CloneRegistry, commonDir: string, receiptIds: ReadonlySet<string>): CloneRegistry {
  return {
    version: 1,
    clones: registry.clones.flatMap((clone) => {
      if (clone.commonDir !== commonDir) return [clone]
      const left = clone.receiptIds.filter((id) => !receiptIds.has(id))
      return left.length === 0 ? [] : [{ ...clone, receiptIds: left }]
    }),
  }
}

export function readRegistry(file: string): RegistryRead {
  if (!existsSync(file)) return { kind: "missing" }
  try {
    const parsed = parseRegistry(JSON.parse(readFileSync(file, "utf8")))
    return parsed === undefined ? { kind: "unreadable" } : { kind: "present", value: parsed }
  } catch {
    return { kind: "unreadable" }
  }
}

/** The registry files in the directory; empty if it does not exist. */
export function registryFiles(env: NodeJS.ProcessEnv): string[] {
  const directory = cloneRegistryDirectory(env)
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(directory, name))
  } catch {
    return []
  }
}

/**
 * Change one registry under its lease. `update` sees the registry as it is now (empty if the file
 * is missing) and returns the next one; a registry left without clones is deleted. An unreadable
 * file is never overwritten: the call throws.
 */
export async function updateRegistry(
  file: string,
  lock: Partial<LockOptions> & { now: () => number },
  update: (current: CloneRegistry) => CloneRegistry,
): Promise<void> {
  const directory = join(file, "..")
  mkdirSync(directory, { recursive: true })
  await lockedWrite(directory, file, { sessionID: "delivery", ...lock }, () => {
    const read = readRegistry(file)
    if (read.kind === "unreadable") throw new Error(`the clone registry ${file} cannot be read`)
    const next = update(read.kind === "present" ? read.value : { version: 1, clones: [] })
    if (next.clones.length === 0) {
      rmSync(file, { force: true })
      return
    }
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  })
}
