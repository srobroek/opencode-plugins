const MAX_DEPTH = 10

/** The root of a session in the TUI's synced data, or the first id whose parent is not loaded. */
export function rootOf(get: (id: string) => { parentID?: string | null } | undefined, sessionID: string): string {
  let id = sessionID
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = get(id)?.parentID
    if (!parent) return id
    id = parent
  }
  return id
}
