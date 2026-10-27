/**
 * Keeps shipped migrations append-only, for any language. Every database that ran a
 * shipped migration keeps the old statements, so editing the file makes the recorded
 * history and the live schema disagree.
 *
 * "Shipped" is read from git: the file exists at the merge base of HEAD with the
 * default branch. A migration that is untracked or was added on this branch is still
 * being authored, so it stays editable and can be renumbered during a rebase. Outside
 * git (or when git cannot answer) the ordered layouts fall back to "only the newest
 * migration is editable"; Alembic revisions have no order, so they are left alone.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { writtenPaths } from "@srobroek/opencode-lib/tool-targets"
import { type Budget, budget, gitOut } from "./probes.ts"

export const MIGRATION_ENV = "SAFETY_ALLOW_MIGRATION_EDIT"

/** `ordered`: entries sort by their numeric prefix. `alembic`: revision ids, no order. */
export type MigrationLayout = "ordered" | "alembic"

/** The migrations directory, the entry directly inside it the path belongs to, and its layout. */
export type MigrationTarget = { dir: string; entry: string; layout: MigrationLayout }

/** `0001_`, `20240115120000_`, `2024-01-15-120000_` (diesel), `V1__`/`U1__` (refinery, flyway). */
const ORDERED_ENTRY = /^[VU]?(\d+(?:[._-]\d+)*)/

/**
 * Where `path` sits in a migrations directory, or `null`. Read lexically, deepest match
 * first. Ordered layouts: `migrations/` (sqlx, diesel, refinery, goose, Django, Prisma,
 * knex), `db/migrate/` (Rails) and `db/migration/` (Flyway). Alembic: a `*.py` file
 * directly in `versions/`; whether it is one depends on a sibling `env.py`.
 */
export function migrationTarget(path: string): MigrationTarget | null {
  const parts = path.replaceAll("\\", "/").split("/")
  for (let at = parts.length - 2; at >= 0; at--) {
    const name = parts[at] as string
    const entry = parts[at + 1] as string
    const dir = parts.slice(0, at + 1).join("/") || name
    const ordered = name === "migrations" || (parts[at - 1] === "db" && (name === "migrate" || name === "migration"))
    if (ordered && ORDERED_ENTRY.test(entry)) return { dir, entry, layout: "ordered" }
    if (name === "versions" && at + 2 === parts.length && entry.endsWith(".py") && !entry.startsWith("__"))
      return { dir, entry, layout: "alembic" }
  }
  return null
}

/** The numeric groups of an entry's prefix: `2024-01-15-120000_x` is `[2024, 1, 15, 120000]`. */
export function orderKey(entry: string): bigint[] | undefined {
  const digits = ORDERED_ENTRY.exec(entry)?.[1]
  return digits === undefined ? undefined : digits.split(/[._-]/).map((group) => BigInt(group))
}

function compareKeys(left: bigint[], right: bigint[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? -1n
    const b = right[i] ?? -1n
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** The newest entry of an ordered migrations directory; prefixes compare as numbers. */
export function latestMigration(dir: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  let best: { name: string; key: bigint[] } | undefined
  for (const name of names) {
    const key = orderKey(name)
    if (key === undefined) continue
    const order = best === undefined ? 1 : compareKeys(key, best.key)
    if (order > 0 || (order === 0 && best !== undefined && name > best.name)) best = { name, key }
  }
  return best?.name
}

const BASE_REFS = [
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
]

/**
 * Whether the existing file `path` is at the merge base of HEAD with the default
 * branch: `true` shipped, `false` added on this branch or untracked, `undefined` when
 * git cannot tell (no repository, no default branch, a timeout).
 */
export async function shipped(path: string, run: Budget["run"]): Promise<boolean | undefined> {
  try {
    const dir = dirname(path)
    const top = (await gitOut(run, ["rev-parse", "--show-toplevel"], dir))?.trim()
    if (!top) return undefined
    const refs = (await gitOut(run, ["for-each-ref", "--format=%(refname)", ...BASE_REFS], top))?.split("\n") ?? []
    const ref = BASE_REFS.find((candidate) => refs.includes(candidate))
    if (ref === undefined) return undefined
    const base = (await gitOut(run, ["merge-base", "HEAD", ref], top))?.trim()
    if (!base) return undefined
    const rel = relative(realpathSync(top), realpathSync(path)).replaceAll("\\", "/")
    const found = await run(["git", "cat-file", "-e", `${base}:${rel}`], top)
    return found === null ? undefined : found.exitCode === 0
  } catch {
    return undefined
  }
}

/** `latest` set: git could not tell, and `path` is older than that newest migration. */
export function migrationRefusal(path: string, latest?: string): string {
  const reason = latest === undefined ? "it is on the default branch" : `it is older than the newest, '${latest}'`
  return (
    `Blocked by safety (migration-edit): '${path}' is a migration that has shipped (${reason}). ` +
    "Databases that ran it keep the old version. Add a NEW migration with the change instead; " +
    `migrations added on this branch stay editable. The user can set ${MIGRATION_ENV}=1 to override.`
  )
}

export type MigrationOptions = { run?: Budget["run"] }

/** The refusal for writing absolute `path`, or `undefined` to let it through. */
export async function decidePath(path: string, options: MigrationOptions = {}): Promise<string | undefined> {
  const target = migrationTarget(path)
  if (!target || !existsSync(path)) return undefined
  if (target.layout === "alembic" && !existsSync(join(dirname(target.dir), "env.py"))) return undefined
  const state = await shipped(path, options.run ?? budget({ timeoutMs: 5_000, budgetMs: 10_000 }).run)
  if (state === true) return migrationRefusal(path)
  if (state === false || target.layout === "alembic") return undefined
  const latest = latestMigration(target.dir)
  if (latest === undefined || latest === target.entry) return undefined
  return migrationRefusal(path, latest)
}

/** The refusal for an `edit`, `write`, `patch` or shell call, or `undefined` to let it run. */
export async function decideToolCall(
  tool: string,
  input: unknown,
  cwd: string,
  options: MigrationOptions = {},
): Promise<string | undefined> {
  for (const path of writtenPaths(tool, input, cwd)) {
    const reason = await decidePath(path, options)
    if (reason) return reason
  }
  return undefined
}

/** Whether the escape hatch is set in `env`. */
export function migrationOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[MIGRATION_ENV]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}
