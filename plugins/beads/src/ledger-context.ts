/**
 * Which ledger a gate read, and whether it belongs to the repository the command runs in.
 *
 * A gate that refuses on a ledger the agent did not expect (a parent directory's, a pinned
 * `BEADS_DIR`) is only debuggable when the refusal names that ledger. The readers here are
 * thin; the wording and the mismatch decision are pure.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type LedgerContext = {
  /** The directory the walk started from. */
  from: string
  /** The `.beads` directory the walk found. */
  store: string
  /** The issue prefix or database name, when the ledger's files say one. */
  prefix?: string
  retired: boolean
}

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

/** `issue-prefix:` from config.yaml, else the `dolt_database` name from metadata.json. */
export function ledgerPrefix(store: string): string | undefined {
  try {
    const match = /^issue-prefix:\s*["']?([^"'\s#]+)/m.exec(readFileSync(join(store, "config.yaml"), "utf8"))
    if (match?.[1]) return match[1]
  } catch {}
  try {
    const metadata = JSON.parse(readFileSync(join(store, "metadata.json"), "utf8")) as { dolt_database?: unknown }
    if (typeof metadata.dolt_database === "string" && metadata.dolt_database !== "") return metadata.dolt_database
  } catch {}
  return undefined
}

/** One sentence naming the ledger, its prefix and the directory the walk started from. */
export function describeLedger(ledger: LedgerContext): string {
  const prefix = ledger.prefix === undefined ? "" : ` (prefix ${JSON.stringify(ledger.prefix)})`
  const state = ledger.retired ? " It is RETIRED." : ""
  return `Ledger read: ${ledger.store}${prefix}, found by walking up from ${ledger.from}.${state} If that is not this project's ledger, you are in the wrong repository: pass the shell tool's \`workdir\` for the right one.`
}

/**
 * Warn when the ledger a `bd create` writes to lives in another git repository than the
 * command's directory. `identity` maps a directory to its repository (git common dir);
 * an unknown answer, or a command directory outside any repository, stays silent.
 */
export function ledgerRepoMismatch(input: {
  store: string
  cwd: string
  identity: (dir: string) => string | undefined
}): string | undefined {
  const ledgerRoot = dirname(input.store)
  const here = input.identity(input.cwd)
  const there = input.identity(ledgerRoot)
  if (here === undefined || there === undefined) return undefined
  // `repoIdentity` answers the directory itself outside any repository.
  if (here === input.cwd) return undefined
  if (here === there) return undefined
  return `This \`bd create\` will write to the ledger ${input.store}, which belongs to ${ledgerRoot}, not to the git repository you are in (${input.cwd}). If that is the wrong project, pass the shell tool's \`workdir\` for the right repository (and unset BEADS_DIR) instead of \`cd\`.`
}

/** The store a `bd create` would use: command-local or ambient `BEADS_DIR`, else the nearest ledger. */
export function createStore(cwd: string, localBeadsDir: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const pinned = localBeadsDir ?? env.BEADS_DIR
  if (pinned !== undefined && pinned !== "") return isAbsolute(pinned) ? pinned : resolve(cwd, pinned)
  return findLedger(cwd)?.store
}
