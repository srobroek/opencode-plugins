export interface Outcome {
  readonly ok: boolean
  readonly errors?: readonly string[]
}

/** The server answers `unknown round <id>` for a round it does not hold, as after a plugin reload that lost it. */
export const isUnknownRound = (errors: readonly string[]) => errors.some((error) => /unknown round/i.test(error))
/** The server answers `undelivered round <id>: <error>` for a closed round whose message to the agent kept failing. */
export const isUndeliveredRound = (errors: readonly string[]) => errors.some((error) => /undelivered round/i.test(error))

export interface SubmitFlow {
  /** Sends the answers to the round. */
  readonly submit: () => Promise<Outcome>
  /** Sends the answers to the session as a message (for a failed round, the server sends its own message again). */
  readonly deliver: () => Promise<Outcome>
  /** Asks what to do with answers that did not reach the agent: true sends them as a message, false dismisses. */
  readonly choose: () => Promise<boolean>
  /** Tells the server the user dismissed the card. */
  readonly dismiss: () => Promise<void>
  readonly notify: (message: string, variant?: "success" | "warning" | "error") => void
  /** Brings the card in line with the server: it drops a round the server no longer lists. */
  readonly settle: () => Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Submits a round's answers. When they cannot reach the agent through the round (the server lost the
 * round, or its message kept failing), the user is never stranded: the error shows once, then they pick
 * between sending the answers as a message and dismissing the card. Returns the problems to show on the
 * card (none when the card is done).
 */
export async function submitRound(flow: SubmitFlow): Promise<string[]> {
  const outcome = await flow.submit().catch((error): Outcome => ({ ok: false, errors: [messageOf(error)] }))
  if (outcome.ok) {
    // Errors on success: the round took the answers but the first message to the agent failed. The server
    // retries it, and brings the card back if it keeps failing.
    if (outcome.errors?.length) flow.notify(outcome.errors.join(" "), "warning")
    else flow.notify("Answers sent", "success")
    await flow.settle()
    return []
  }
  const errors = [...(outcome.errors ?? ["Submit failed"])]
  if (isUnknownRound(errors)) flow.notify("This round is gone from the server (the plugin probably reloaded).", "warning")
  else if (isUndeliveredRound(errors)) flow.notify(errors.join(" "), "warning")
  else return errors
  if (!(await flow.choose())) {
    await flow.dismiss()
    await flow.settle()
    return []
  }
  const sent = await flow.deliver().catch((error): Outcome => ({ ok: false, errors: [messageOf(error)] }))
  if (!sent.ok) return [...(sent.errors ?? ["Could not send the answers as a message"])]
  flow.notify("Answers sent as a message", "success")
  await flow.settle()
  return []
}
