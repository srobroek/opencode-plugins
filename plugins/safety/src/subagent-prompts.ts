/**
 * A permission prompt in a subagent session can wait for an answer that never comes: nobody watches a
 * background child, and the TUI does not surface every descendant's prompt. The tool call then blocks
 * with no error. This turns such an ask into a deny whose message names the permission, the resources
 * and what to do instead, so the subagent sees the failure at once and can report it to its parent.
 */

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string; message?: string }

/** The session fields the decision reads; `parentID` is set for a subagent session. */
export type SessionInfo = { readonly parentID?: string | null; readonly location?: { readonly directory?: string } }

/** The denial a subagent sees in place of a prompt it cannot answer. */
export function unanswerableMessage(action: string, resources: ReadonlyArray<string>, directory: string | undefined): string {
  const what = `${action} denied for ${resources.join(", ")}: subagent sessions cannot answer permission prompts; `
  if (action === "external_directory")
    return `${what}work inside ${directory ?? "the session directory"} or ask the parent to copy the file in.`
  return `${what}ask the parent session to run it or to grant ${action}.`
}

/**
 * The denial for a request in `session`, or `undefined` when the session has no parent or is unknown, so
 * nothing shows that nobody can answer. The reason an earlier hook gave for asking stays after the denial.
 */
export function unanswerableDenial(
  request: { readonly action: string; readonly resources: ReadonlyArray<string>; readonly message?: string | undefined },
  session: SessionInfo | undefined,
): string | undefined {
  if (typeof session?.parentID !== "string" || session.parentID === "") return undefined
  const message = unanswerableMessage(request.action, request.resources, session.location?.directory)
  return request.message ? `${message}\n\n${request.message}` : message
}

/** Deny an ask in a session that has a parent; a root or unknown session keeps its prompt. */
export function denyUnanswerable(evaluation: Evaluation, session: SessionInfo | undefined): void {
  if (evaluation.effect !== "ask") return
  const message = unanswerableDenial(evaluation, session)
  if (message === undefined) return
  evaluation.effect = "deny"
  evaluation.message = message
}
