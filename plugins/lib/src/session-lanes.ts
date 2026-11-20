/**
 * Find and relocate the sessions of a lane: a root session and everything it spawned.
 *
 * `session.list` accepts `parentID` (`SessionListInput` in `@opencode/client`), so descendants are
 * found by listing children level by level. `session.move` resolves the source from the session
 * record, so it works after the source directory is deleted; only the destination must exist.
 */

export type LaneSessionClient = {
  list: (query: { parentID: string; limit?: number; cursor?: string }) => Promise<unknown>
  move: (input: { sessionID: string; directory: string }) => Promise<unknown>
}

export const MAX_LANE_DEPTH = 8
export const LANE_CALL_TIMEOUT_MS = 10_000
const MAX_PAGES = 20

export type LaneSessions = {
  /** The root first, then descendants breadth first. */
  ids: string[]
  /** False when a listing failed or timed out, or sessions exist below the depth cap. */
  complete: boolean
}

export type MoveResult = { id: string; status: "moved" } | { id: string; status: "not-found" } | { id: string; status: "error"; reason: string }

/**
 * Whether a rejected `session.get` is the host saying THIS session does not exist. Location,
 * service, transport and conflicting-status failures are not: they say nothing about the session
 * (a session whose directory is gone fails with "Location not found" while it still exists).
 * The error must either be a session-typed not-found, or name the session id and say it is missing.
 */
export function isSessionNotFound(error: unknown, sessionID: string): boolean {
  if (typeof error !== "object" || error === null) return false
  const fields = error as { name?: unknown; _tag?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; sessionID?: unknown }
  for (const status of [fields.status, fields.statusCode]) if (status !== undefined && status !== 404) return false
  const message = typeof fields.message === "string" ? fields.message : ""
  // Another resource is missing, not the session.
  if (/\b(location|service|directory|project|worktree|agent)\b/i.test(message)) return false
  const kind = [fields.name, fields._tag].filter((value): value is string => typeof value === "string")
  if (kind.some((value) => /^session.?not.?found/i.test(value))) return fields.sessionID === undefined || fields.sessionID === sessionID
  const named = fields.sessionID === sessionID || message.includes(sessionID)
  if (!named) return false
  return kind.some((value) => /not.?found/i.test(value)) || /not found|no session|no such session|does not exist/i.test(message)
}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Direct children of `parentID`, all pages; throws on failure or timeout. */
async function children(client: LaneSessionClient, parentID: string, ms: number): Promise<string[]> {
  const found: string[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const query = cursor === undefined ? { parentID, limit: 100 } : { parentID, limit: 100, cursor }
    const page = (await within(
      Promise.resolve().then(() => client.list(query)),
      ms,
    )) as { data?: unknown; cursor?: { next?: string } } | undefined
    if (!page || !Array.isArray(page.data)) throw new Error("unreadable listing")
    for (const raw of page.data) {
      const id = (raw as { id?: unknown } | null)?.id
      if (typeof id === "string") found.push(id)
    }
    cursor = page.cursor?.next
    if (!cursor) return found
  }
  throw new Error("listing did not end within the page cap")
}

/**
 * The root and all descendants, breadth first, to `maxDepth` levels, each `session.list` call under
 * `timeoutMs`. Never throws: a failed, timed-out or capped listing marks the answer incomplete.
 */
export async function laneSessions(
  client: LaneSessionClient,
  rootID: string,
  options: { maxDepth?: number; timeoutMs?: number } = {},
): Promise<LaneSessions> {
  const maxDepth = options.maxDepth ?? MAX_LANE_DEPTH
  const timeoutMs = options.timeoutMs ?? LANE_CALL_TIMEOUT_MS
  const seen = new Set([rootID])
  const ids = [rootID]
  let level = [rootID]
  let complete = true
  for (let depth = 1; level.length > 0; depth++) {
    const next: string[] = []
    for (const parent of level) {
      let kids: string[]
      try {
        kids = await children(client, parent, timeoutMs)
      } catch {
        complete = false
        continue
      }
      for (const id of kids) {
        if (seen.has(id)) continue
        seen.add(id)
        next.push(id)
      }
    }
    if (depth > maxDepth) {
      if (next.length > 0) complete = false
      break
    }
    ids.push(...next)
    level = next
  }
  return { ids, complete }
}

/** Move each session to `destination` (which must exist). One result per id; a failure never stops the rest. */
export async function moveSessionsHome(client: LaneSessionClient, ids: readonly string[], destination: string): Promise<MoveResult[]> {
  const results: MoveResult[] = []
  for (const id of ids) {
    try {
      await client.move({ sessionID: id, directory: destination })
      results.push({ id, status: "moved" })
    } catch (error) {
      if (isSessionNotFound(error, id)) results.push({ id, status: "not-found" })
      else results.push({ id, status: "error", reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
