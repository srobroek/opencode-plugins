/**
 * Move sessions out of a worktree before it is removed.
 *
 * OpenCode resolves a session's location for every request that touches the session (the TUI
 * listing it, a wake or drain, a plugin calling `session.get`). A session whose directory is gone
 * fails all of them with "Location not found". So a remover moves every idle session whose location
 * is the target, or inside it, to the repository's canonical checkout first, and refuses to remove
 * if a session there is running, or if any lookup or move fails.
 *
 * The adapter takes the few `ctx.session` calls it needs, so delivery and subagent-worktree (which
 * bundle separate copies of this lib) both use it.
 */

import { existsSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { canonicalDirectory } from "./worktree-claims.ts"

export type SessionLike = {
  id: string
  location?: { directory?: string }
  time?: { busy?: unknown; idle?: unknown }
}

export type SessionApi = {
  list: (query: never) => Promise<unknown>
  move: (input: never) => Promise<unknown>
}

const MAX_PAGES = 100

const toMillis = (value: unknown): number | undefined => {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** Whether the session's latest execution started and has not ended. */
export function sessionRunning(session: Pick<SessionLike, "time">): boolean {
  const busy = toMillis(session.time?.busy)
  const idle = toMillis(session.time?.idle)
  return busy !== undefined && (idle === undefined || busy > idle)
}

/** Whether `path` is `directory` or below it. Both canonical. Pure. */
export function insideDirectory(path: string, directory: string): boolean {
  const root = directory.replace(/\/+$/, "")
  return path === root || path.startsWith(`${root}/`)
}

/** The repository's canonical main checkout from its git common directory, or `fallback`. Pure. */
export function canonicalCheckout(commonDir: string | undefined, fallback: string): string {
  if (commonDir !== undefined && basename(commonDir) === ".git") return dirname(commonDir)
  return fallback
}

/**
 * Every session of the project, all pages. `undefined` when any page cannot be read or the listing
 * does not end within the page cap: an incomplete answer is unknown, never "none".
 */
export async function listProjectSessions(api: Pick<SessionApi, "list">, projectID: string | undefined): Promise<SessionLike[] | undefined> {
  const found: SessionLike[] = []
  let query: Record<string, unknown> = { ...(projectID === undefined ? {} : { project: projectID }), archived: false, limit: 100 }
  try {
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const page = (await api.list(query as never)) as { data?: unknown; cursor?: { next?: string } } | undefined
      if (!page || !Array.isArray(page.data)) return undefined
      for (const raw of page.data) {
        const session = raw as SessionLike
        if (typeof session?.id === "string") found.push(session)
      }
      const next = page.cursor?.next
      if (!next) return found
      query = { cursor: next }
    }
  } catch {
    return undefined
  }
  return undefined
}

export type Eviction = { ok: true; moved: string[] } | { ok: false; reason: string }

/**
 * Run under the removal lock, right before the removal. Running sessions block it; each idle session in
 * the target is moved to `destination`; a failed lookup or move blocks it. `exclude` skips sessions the
 * caller already handled (a lane's own child, moved home separately).
 */
export async function evictSessions(
  api: SessionApi,
  options: { projectID: string | undefined; directory: string; destination: string; exclude?: ReadonlySet<string> },
): Promise<Eviction> {
  const sessions = await listProjectSessions(api, options.projectID)
  if (sessions === undefined) return { ok: false, reason: `the sessions of the project could not all be listed, so who is in ${options.directory} is unknown` }
  const target = canonicalDirectory(options.directory)
  const inside = sessions.filter((session) => {
    if (options.exclude?.has(session.id)) return false
    const where = session.location?.directory
    return typeof where === "string" && insideDirectory(canonicalDirectory(where), target)
  })
  const running = inside.find(sessionRunning)
  if (running) return { ok: false, reason: `session ${running.id} is running in ${options.directory}` }
  const moved: string[] = []
  for (const session of inside) {
    try {
      await api.move({ sessionID: session.id, directory: options.destination } as never)
      moved.push(session.id)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `session ${session.id} could not be moved out of ${options.directory} (${why}); nothing was removed` }
    }
  }
  return { ok: true, moved }
}

export type Repair = { moved: Array<{ sessionID: string; from: string; to: string }>; failed: Array<{ sessionID: string; reason: string }> }

/**
 * Move every session whose location directory no longer exists to the destination `destinationFor`
 * names for it (the canonical checkout of its repository if that can be worked out, else the project
 * root). A session whose directory is gone cannot run, so this is safe; sessions with existing
 * directories are left alone. Each move is logged through `log`.
 */
export async function repairStrandedSessions(
  api: SessionApi,
  options: {
    projectID: string | undefined
    destinationFor: (session: SessionLike) => string
    exists?: (path: string) => boolean
    log?: (line: string) => void
  },
): Promise<Repair | { error: string }> {
  const sessions = await listProjectSessions(api, options.projectID)
  if (sessions === undefined) return { error: "the sessions of the project could not all be listed" }
  const exists = options.exists ?? existsSync
  const result: Repair = { moved: [], failed: [] }
  for (const session of sessions) {
    const where = session.location?.directory
    if (typeof where !== "string" || where === "" || exists(resolve(where))) continue
    if (sessionRunning(session)) continue
    const to = options.destinationFor(session)
    try {
      await api.move({ sessionID: session.id, directory: to } as never)
      result.moved.push({ sessionID: session.id, from: where, to })
      options.log?.(`moved session ${session.id} out of ${where} (gone) to ${to}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      result.failed.push({ sessionID: session.id, reason })
      options.log?.(`could not move session ${session.id} out of ${where}: ${reason}`)
    }
  }
  return result
}
