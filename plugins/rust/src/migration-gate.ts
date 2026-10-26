/**
 * Blocks edits to a migration that is already committed history. Ported from
 * omp-plugins (`rust/extensions/migration-edit-gate.ts`).
 *
 * Numbered migrations are append-only: once a migration has shipped, every
 * database that ran it keeps the old statements, so editing the file makes the
 * recorded history and the live schema disagree. The single exception is the
 * highest-numbered migration in the directory, the one still being authored.
 * Creating a new migration is always allowed.
 */

import { existsSync, readdirSync } from "node:fs"
import { writtenPaths } from "@srobroek/opencode-lib/tool-targets"

const NUMERIC_PREFIX = /^(\d+)/

export type MigrationTarget = { dir: string; entry: string }

/**
 * The migrations directory and the numbered entry inside it, or `null` when the
 * path is not a numbered migration. The entry is the segment directly under
 * `migrations/`, so per-migration directories (`0003_name/up.sql`) resolve to the
 * same unit as flat files (`0003_name.sql`).
 */
export function migrationTarget(path: string): MigrationTarget | null {
  const parts = path.replaceAll("\\", "/").split("/")
  const at = parts.lastIndexOf("migrations")
  if (at === -1 || at + 1 >= parts.length) return null
  const entry = parts[at + 1] ?? ""
  if (!NUMERIC_PREFIX.test(entry)) return null
  return { dir: parts.slice(0, at + 1).join("/") || "migrations", entry }
}

/**
 * Highest-numbered entry in a migrations directory. Prefixes are compared as
 * numbers first: lexical order alone would rank `2_x` above `10_x`.
 */
export function latestMigration(dir: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  let best: { name: string; ordinal: number } | undefined
  for (const name of names) {
    const digits = NUMERIC_PREFIX.exec(name)?.[1]
    if (!digits) continue
    const ordinal = Number(digits)
    if (!Number.isFinite(ordinal)) continue
    if (!best || ordinal > best.ordinal || (ordinal === best.ordinal && name > best.name)) best = { name, ordinal }
  }
  return best?.name
}

export function migrationRefusal(path: string, latest: string): string {
  return (
    `Migrations are append-only: '${path}' is committed migration history. ` +
    "Every database that already ran it keeps the old statements, so editing the file makes the " +
    `recorded history and the live schema disagree. Only the latest migration ('${latest}') is ` +
    `still editable. Express this change as a NEW migration with the next prefix after ` +
    `'${latest}' (an ALTER, not a rewrite). Reading the file is unaffected.`
  )
}

/** The refusal for writing absolute `path`, or `undefined` when it is not older migration history. */
export function decidePath(path: string): string | undefined {
  const target = migrationTarget(path)
  if (!target) return undefined
  // A migration that does not exist yet is the new one being written.
  if (!existsSync(path)) return undefined
  const latest = latestMigration(target.dir)
  if (latest === undefined || latest === target.entry) return undefined
  return migrationRefusal(path, latest)
}

/** The refusal for an `edit`, `write`, `patch` or `shell` call, or `undefined` to let it run. */
export function decideToolCall(tool: string, input: unknown, cwd: string): string | undefined {
  for (const path of writtenPaths(tool, input, cwd)) {
    const reason = decidePath(path)
    if (reason) return reason
  }
  return undefined
}
