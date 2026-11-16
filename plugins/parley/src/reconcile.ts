import type { RoundView } from "./rounds.ts"

/**
 * Merges the server's open rounds for one location into the TUI's entries. A round the server no
 * longer lists is normally closed elsewhere and drops with its draft. After a server reload it may
 * only have been lost (a server that kept nothing across the reload), and the user's draft is all
 * that is left of it, so it stays until the user sends it as a message or dismisses it.
 */
export function reconcileRounds<T extends { readonly view: RoundView }>(input: {
  readonly current: readonly T[]
  readonly server: readonly RoundView[]
  readonly lost: ReadonlySet<string>
  readonly reloaded: boolean
  readonly toEntry: (view: RoundView) => T
}): { entries: T[]; lost: Set<string>; forget: string[] } {
  const listed = new Set(input.server.map((view) => view.roundID))
  const lost = new Set([...input.lost].filter((id) => !listed.has(id)))
  const forget: string[] = []
  const kept: T[] = []
  for (const entry of input.current) {
    const id = entry.view.roundID
    if (listed.has(id)) continue
    if (input.reloaded || lost.has(id)) {
      lost.add(id)
      kept.push(entry)
    } else forget.push(id)
  }
  return { entries: [...input.server.map(input.toEntry), ...kept], lost, forget }
}

/** Records the server instance a location answered from; true when it differs from the one seen before. */
export function instanceChanged(known: Map<string, string>, key: string, instance: string | undefined): boolean {
  if (instance === undefined) return false
  const before = known.get(key)
  known.set(key, instance)
  return before !== undefined && before !== instance
}
