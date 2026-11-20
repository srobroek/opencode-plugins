// Sessions of a lane whose worktree delivery removes. Once the directory is gone a session that
// still points at it fails with "Location not found", so the lane's own sessions are moved home to
// the canonical checkout. Only the lane is touched: its root sessions and their descendants, never
// a project-wide listing.

import { sep } from "node:path"
import { type LaneSessionClient, type LaneSessions, laneSessions, moveSessionsHome } from "@srobroek/opencode-lib/session-lanes"
import { canonicalDirectory } from "@srobroek/opencode-lib/worktree-claims"

export type LaneClient = LaneSessionClient & { get: (input: { sessionID: string }) => Promise<unknown> }

const within = (directory: string, worktree: string): boolean => {
  const have = canonicalDirectory(directory)
  const want = canonicalDirectory(worktree)
  return have === want || have.startsWith(want.endsWith(sep) ? want : `${want}${sep}`)
}

// The sessions below `roots` (the roots included) whose location is `worktree` or inside it. Read
// before the removal: afterwards a session in a deleted directory can no longer be read. An
// unreadable session is left out; a failed listing makes the answer incomplete.
export async function laneSessionsIn(client: LaneClient, roots: readonly string[], worktree: string): Promise<LaneSessions> {
  const ids: string[] = []
  let complete = true
  for (const root of roots) {
    const lane = await laneSessions(client, root)
    if (!lane.complete) complete = false
    for (const id of lane.ids) {
      if (ids.includes(id)) continue
      const session = (await client.get({ sessionID: id }).catch(() => undefined)) as { location?: { directory?: unknown } } | undefined
      const directory = session?.location?.directory
      if (typeof directory === "string" && within(directory, worktree)) ids.push(id)
    }
  }
  return { ids, complete }
}

// Move `lane` to `destination`; one note per problem, none when every session moved. A session
// that no longer exists is not a problem.
export async function moveLaneHome(client: LaneClient, lane: LaneSessions, destination: string): Promise<string[]> {
  const notes: string[] = []
  for (const result of await moveSessionsHome(client, lane.ids, destination)) {
    if (result.status === "error") notes.push(`session ${result.id} could not be moved to ${destination}: ${result.reason}`)
  }
  if (!lane.complete) notes.push("the lane's sessions were listed incompletely; some may still point at the removed worktree")
  return notes
}
