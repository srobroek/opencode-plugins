/** Background questions must not replace a different session's unanswered question. */
export function canAutoPresent(target: string, current: string | undefined, pending: readonly string[]): boolean {
  return current === undefined || current === target || !pending.includes(current)
}

/** A late completion may close only its own session's panel, and never a newer round. */
export function canCloseRoundPanel(
  panel: { name: string; sessionID: string } | undefined,
  name: string,
  sessionID: string,
  stillPending: boolean,
): boolean {
  return panel?.name === name && panel.sessionID === sessionID && !stillPending
}
