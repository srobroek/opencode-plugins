/**
 * Whether a Session that goes idle still has background work, as OpenCode's
 * `session.hook("experimental.idle")` reports it.
 *
 * Since OpenCode 2.3.0 the hook carries `background`: the shells, subagents and image jobs
 * still running for the idle Session or its descendants, each with the `sessionID` that owns
 * it. The host runs the hook just before the execution ends, so it comes before the
 * `created` time of that execution's terminal event. When work the Session owns finishes, its
 * notice wakes the Session again, so a later idle follows. Work a descendant owns wakes that
 * descendant instead, so it says nothing about the Session coming back. A host without the
 * field (2.2.x) reports no background work, and a caller behaves as before.
 */

/** How long a Session that went idle with background work may wait for its next idle before a caller stops waiting. */
export const BACKGROUND_HOLD_MS = 30 * 60_000

/** The timer behind `BACKGROUND_HOLD_MS`; tests pass a fake. */
export type HoldTimer = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export const SYSTEM_HOLD_TIMER: HoldTimer = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** Idle reports kept per Session; older ones are dropped first. */
export const MAX_IDLE_REPORTS = 16

/** The parts of an `experimental.idle` event read here. */
export type IdleReport = { readonly sessionID: string; readonly background?: ReadonlyArray<unknown> }

/** The Session that owns a background item; an item without one counts as the reporting Session's. */
const ownerOf = (item: unknown): unknown =>
  typeof item === "object" && item !== null ? (item as { sessionID?: unknown }).sessionID : undefined

/** Whether `idle` says the Session still runs background work it owns, whose notice wakes it again. */
export function childStillWorking(idle: IdleReport | undefined): boolean {
  if (idle === undefined || !Array.isArray(idle.background)) return false
  return idle.background.some((item) => {
    const owner = ownerOf(item)
    return typeof owner !== "string" || owner === idle.sessionID
  })
}

/**
 * What an execution end learns from the idle reports before it: `working` when the last one
 * had background work the Session owns, `done` when it had none or there was no report, and
 * `unknown` when that report was dropped past `MAX_IDLE_REPORTS`. A caller treats `unknown` as
 * `working`, so lost evidence holds rather than ends.
 */
export type IdleEvidence = "working" | "done" | "unknown"

/**
 * Each Session's idle reports, stamped when the hook runs and read by the execution ends that
 * follow. The hook carries no execution id, so a report belongs to the first end whose
 * `created` time is not before it: events read late still meet their own report.
 */
export class IdleReports {
  readonly #reports = new Map<string, Array<{ at: number; working: boolean }>>()
  /** Per Session, the time of the newest report dropped past `MAX_IDLE_REPORTS` and not yet read past. */
  readonly #dropped = new Map<string, number>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  record(idle: IdleReport): void {
    const reports = this.#reports.get(idle.sessionID) ?? []
    reports.push({ at: this.#now(), working: childStillWorking(idle) })
    if (reports.length > MAX_IDLE_REPORTS) {
      const dropped = reports.splice(0, reports.length - MAX_IDLE_REPORTS)
      const newest = dropped.at(-1)?.at
      if (newest !== undefined) this.#dropped.set(idle.sessionID, newest)
    }
    this.#reports.set(idle.sessionID, reports)
  }

  /**
   * For an execution end published at `endedAt`: what its last idle report said. Reads and
   * drops every report made up to `endedAt`; an end without a time reads them all.
   */
  take(sessionID: string, endedAt = Number.POSITIVE_INFINITY): IdleEvidence {
    const dropped = this.#dropped.get(sessionID)
    const lost = dropped !== undefined && dropped <= endedAt
    if (lost) this.#dropped.delete(sessionID)
    const reports = this.#reports.get(sessionID) ?? []
    let read = 0
    while (read < reports.length && (reports[read]?.at ?? Number.POSITIVE_INFINITY) <= endedAt) read++
    const last = read > 0 ? reports[read - 1] : undefined
    reports.splice(0, read)
    if (reports.length === 0) this.#reports.delete(sessionID)
    if (last !== undefined) return last.working ? "working" : "done"
    return lost ? "unknown" : "done"
  }

  forget(sessionID: string): void {
    this.#reports.delete(sessionID)
    this.#dropped.delete(sessionID)
  }

  clear(): void {
    this.#reports.clear()
    this.#dropped.clear()
  }
}
