export interface Outcome {
  readonly ok: boolean
  readonly errors?: readonly string[]
}

/** The server answers `unknown round <id>` for a round it does not hold, as after a plugin reload that lost it. */
export const isUnknownRound = (errors: readonly string[]) => errors.some((error) => /unknown round/i.test(error))

export interface SubmitFlow {
  /** Sends the answers to the round. */
  readonly submit: () => Promise<Outcome>
  /** Sends the same answers to the session as a message. */
  readonly deliver: () => Promise<Outcome>
  /** Asks what to do with a round the server lost: true sends the answers as a message, false dismisses. */
  readonly choose: () => Promise<boolean>
  readonly notify: (message: string, variant?: "success" | "warning" | "error") => void
  /** Brings the card in line with the server: it drops a round the server no longer lists. */
  readonly settle: () => Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Submits a round's answers. When the server no longer knows the round, the user is never stranded: the
 * error shows once, then they pick between sending the answers as a message and dismissing the card.
 * Returns the problems to show on the card (none when the card is done).
 */
export async function submitRound(flow: SubmitFlow): Promise<string[]> {
  const outcome = await flow.submit().catch((error): Outcome => ({ ok: false, errors: [messageOf(error)] }))
  if (outcome.ok) {
    // Errors on success: the round took the answers but the message to the session failed; they wait for parley_wait.
    if (outcome.errors?.length) flow.notify(outcome.errors.join(" "), "warning")
    else flow.notify("Answers sent", "success")
    await flow.settle()
    return []
  }
  const errors = [...(outcome.errors ?? ["Submit failed"])]
  if (!isUnknownRound(errors)) return errors
  flow.notify("This round is gone from the server (the plugin probably reloaded).", "warning")
  if (!(await flow.choose())) {
    await flow.settle()
    return []
  }
  const sent = await flow.deliver().catch((error): Outcome => ({ ok: false, errors: [messageOf(error)] }))
  if (!sent.ok) return [...(sent.errors ?? ["Could not send the answers as a message"])]
  flow.notify("Answers sent as a message", "success")
  await flow.settle()
  return []
}
