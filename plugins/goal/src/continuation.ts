// Lets other plugins see that this plugin will continue a session, so only one
// plugin starts the next turn. The plugin entry re-exports these helpers; another
// plugin can also read the registry through
// `Symbol.for("srobroek.goal.continuations")` without depending on this package.

/** `metadata.source` on every message this plugin sends. */
export const GOAL_SOURCE = "srobroek.goal"

/**
 * Process-wide registry of sessions this plugin is currently driving, keyed by
 * session id. Other plugins (the beads stop nudge) read it through
 * `Symbol.for("srobroek.goal.continuations")` without importing this package.
 */
export const CONTINUATION_REGISTRY: unique symbol = Symbol.for("srobroek.goal.continuations") as never

export type ContinuationKind = "goal" | "loop"

export function registry(): Map<string, ContinuationKind> {
  const holder = globalThis as { [CONTINUATION_REGISTRY]?: Map<string, ContinuationKind> }
  holder[CONTINUATION_REGISTRY] ??= new Map()
  return holder[CONTINUATION_REGISTRY]
}

/** `"goal"` or `"loop"` while this plugin will continue the session after its turn ends. */
export function activeContinuation(sessionID: string): ContinuationKind | undefined {
  return registry().get(sessionID)
}

/** True for message metadata written by this plugin. */
export function isGoalSourced(metadata: unknown): boolean {
  return (metadata as { source?: unknown } | null | undefined)?.source === GOAL_SOURCE
}
