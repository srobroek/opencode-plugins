/**
 * Whether a Session that goes idle still has background work, as OpenCode's
 * `session.hook("experimental.idle")` reports it.
 *
 * Since OpenCode 2.3.0 the hook carries `background`: the shells, subagents and image jobs
 * still running for the idle Session or its descendants. The host runs the hook just before
 * the execution ends, so it comes before that execution's `session.execution.succeeded`.
 * When the work finishes, its notice wakes the Session again, so a later idle follows. A host
 * without the field (2.2.x) reports no background work, and a caller behaves as before.
 */

/** The parts of an `experimental.idle` event read here. */
export type IdleReport = { readonly sessionID: string; readonly background?: ReadonlyArray<unknown> }

/** Whether `idle` says the Session still has background work running. */
export function childStillWorking(idle: IdleReport | undefined): boolean {
  return Array.isArray(idle?.background) && idle.background.length > 0
}

/** The latest idle report of each Session, read once by the execution end that follows it. */
export class IdleReports {
  readonly #working = new Map<string, boolean>()

  record(idle: IdleReport): void {
    if (childStillWorking(idle)) this.#working.set(idle.sessionID, true)
    else this.#working.delete(idle.sessionID)
  }

  /** Whether the Session's last idle report had background work; the report is then forgotten. */
  take(sessionID: string): boolean {
    const working = this.#working.get(sessionID) === true
    this.#working.delete(sessionID)
    return working
  }

  clear(): void {
    this.#working.clear()
  }
}
