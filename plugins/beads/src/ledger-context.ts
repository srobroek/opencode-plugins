/**
 * Which ledger a gate read, and whether it belongs to the repository the command runs in.
 *
 * A gate that refuses on a ledger the agent did not expect (a parent directory's, a pinned
 * `BEADS_DIR`) is only debuggable when the refusal names that ledger. The readers here are
 * thin; the wording and the mismatch decision are pure.
 *
 * Ledger files are repository data and reach an agent-facing message, so they are read
 * defensively (regular files only, size-capped, never followed through a symlink) and
 * only a short identifier is quoted from them.
 */

import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export type LedgerContext = {
  /** The directory the walk started from. */
  from: string
  /** The `.beads` directory the walk found. */
  store: string
  /** The issue prefix or database name, when the ledger's files say one. */
  prefix?: string
  retired: boolean
}

/** Ledger metadata is a few lines; anything bigger is not read. */
const MAX_LEDGER_FILE_BYTES = 64 * 1024

/** What a prefix may look like before it is shown to an agent. */
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The nearest `.beads` at or above `from`, the way the PR-link gate walks. */
export function findLedger(from: string): LedgerContext | undefined {
  const start = resolve(from)
  let current = start
  for (;;) {
    const store = join(current, ".beads")
    if (existsSync(store)) {
      const prefix = ledgerPrefix(store)
      return { from: start, store, retired: isRetired(store), ...(prefix === undefined ? {} : { prefix }) }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isRetired(store: string): boolean {
  try {
    return lstatSync(join(store, "RETIRED")).isFile()
  } catch {
    return false
  }
}

/**
 * The text of a small regular file, or undefined. A symlink, a device, a FIFO, an
 * oversized file or any I/O failure all read as absent: this feeds a diagnostic only.
 */
export function readSmallRegularFile(path: string): string | undefined {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) return undefined
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_LEDGER_FILE_BYTES) return undefined
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return buffer.toString("utf8", 0, offset)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** A prefix safe to show an agent: a short ASCII identifier, else undefined. */
export function safePrefix(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PREFIX.test(value) ? value : undefined
}

/** `issue-prefix:` from config.yaml, else the `dolt_database` name from metadata.json. */
export function ledgerPrefix(store: string): string | undefined {
  const config = readSmallRegularFile(join(store, "config.yaml"))
  if (config !== undefined) {
    const match = /^issue-prefix:[ \t]*["']?([^"'\r\n#]*?)["']?[ \t]*(?:#.*)?$/m.exec(config)
    const prefix = safePrefix(match?.[1])
    if (prefix !== undefined) return prefix
  }
  const metadata = readSmallRegularFile(join(store, "metadata.json"))
  if (metadata !== undefined) {
    try {
      return safePrefix((JSON.parse(metadata) as { dolt_database?: unknown }).dolt_database)
    } catch {}
  }
  return undefined
}

/**
 * One sentence naming the ledger, its prefix and the directory the walk started from.
 * Repository data is JSON-quoted; the remediation sentence after it is fixed text.
 */
export function describeLedger(ledger: LedgerContext): string {
  const prefix = ledger.prefix === undefined ? "" : ` (prefix ${JSON.stringify(ledger.prefix)})`
  const state = ledger.retired ? " It is RETIRED." : ""
  return `Ledger read: ${JSON.stringify(ledger.store)}${prefix}, found by walking up from ${JSON.stringify(ledger.from)}.${state} If that is not this project's ledger, you are in the wrong repository: pass the shell tool's \`workdir\` for the right one.`
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Warn when the ledger a `bd create` writes to lives in another git repository than the
 * command's directory. `identity` maps a directory to its repository (git common dir);
 * an unknown answer, or a command directory outside any repository, stays silent.
 * The store is canonicalised first, so a symlinked `.beads` is judged by where it lives.
 */
export function ledgerRepoMismatch(input: {
  store: string
  cwd: string
  identity: (dir: string) => string | undefined
}): string | undefined {
  const store = canonical(input.store)
  const ledgerRoot = dirname(store)
  const here = input.identity(input.cwd)
  const there = input.identity(ledgerRoot)
  if (here === undefined || there === undefined) return undefined
  // `repoIdentity` answers the directory itself outside any repository.
  if (here === input.cwd) return undefined
  if (here === there) return undefined
  return `This \`bd create\` will write to the ledger ${JSON.stringify(store)}, which belongs to ${JSON.stringify(ledgerRoot)}, not to the git repository you are in (${JSON.stringify(input.cwd)}). If that is the wrong project, pass the shell tool's \`workdir\` for the right repository (and unset BEADS_DIR) instead of \`cd\`.`
}
