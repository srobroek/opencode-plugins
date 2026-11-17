/**
 * Mode reminders for primary agents, modelled on OpenCode core's plan mode.
 *
 * A mode is a primary agent whose restrictions the model must keep in mind. On entering one
 * the session gets an inline `<system-reminder>` as a synthetic user message, and on leaving
 * it the reminder is withdrawn by a second one. Compaction and reverts can strip those
 * messages while the agent stays put, so each request is also reconciled: the missing
 * reminder is spliced in before the last user prompt and persisted once.
 *
 * Reminder text is static per mode (no session state), so the prompt cache prefix holds.
 * Core's Plan plugin also rewrites refused-edit errors; that needs `Permission.BlockedError`,
 * which the public plugin API does not export, so it is not done here.
 */

import type { Context } from "@opencode/plugin/promise/plugin"

export type Mode = {
  /** The agent id. */
  id: string
  /** Display name used in the reminder text. */
  name: string
  /** Reminder shown when the session enters the mode. */
  enter: string
  /** Reminder shown when the session leaves the mode. */
  leave: string
  /** Where the mode may edit files, for the allowed-edit summary. */
  allowed: string
}

export type ModeSpec = {
  id: string
  name: string
  /** What the mode does, as a sentence; goes first in the enter text. */
  purpose: string
  /** Where the mode may edit, for example "`specs/` and `.specify/`". */
  allowed: string
  /** What the user must do to get that work done, for example "switch to `build`". */
  redirect: string
}

const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`

/** Build a mode with the standard enter and leave text. */
export function defineMode(spec: ModeSpec): Mode {
  const enter = wrap(
    [
      `You are in ${spec.name} mode: ${spec.purpose}`,
      `You may edit files only in: ${spec.allowed}. Do not modify any other files or ask a subagent to.`,
      `You remain in ${spec.name} mode until the user switches agents. If the user asks for work outside it, do not do it; tell them to ${spec.redirect}.`,
    ].join("\n\n"),
  )
  const leave = wrap(
    `You are NO LONGER in ${spec.name} mode. The previous ${spec.name} restrictions no longer apply. Any ${spec.name} mode instructions from earlier in this conversation are no longer active.`,
  )
  return { id: spec.id, name: spec.name, enter, leave, allowed: spec.allowed }
}

export const enterReminder = (mode: Mode): string => mode.enter
export const leaveReminder = (mode: Mode): string => mode.leave

/**
 * The reminders to inject when a session's agent changes from `previous` to `next`
 * (`previous` is undefined for a new session): the leave text of a mode being left, then
 * the enter text of a mode being entered. Unrelated switches give none.
 */
export function reminderFor(previous: string | undefined, next: string, modes: readonly Mode[]): string[] {
  if (previous === next) return []
  const left = modes.find((mode) => mode.id === previous)
  const entered = modes.find((mode) => mode.id === next)
  return [...(left ? [leaveReminder(left)] : []), ...(entered ? [enterReminder(entered)] : [])]
}

/** The text of a message that is exactly one text part, else undefined. */
function soleText(message: unknown): string | undefined {
  const { role, content } = message as { role?: unknown; content?: unknown }
  if (role !== "user" || !Array.isArray(content) || content.length !== 1) return undefined
  const part = content[0] as { type?: unknown; text?: unknown }
  return part.type === "text" && typeof part.text === "string" ? part.text : undefined
}

/**
 * The reminders a request is missing: compares the last reminder in `messages` with the mode
 * of `agent`. Gives the enter text when `agent` is a mode whose enter text is not the last
 * reminder, and the leave text when the last reminder is an enter text of a mode `agent` is not.
 */
export function missingReminders(agent: string, messages: readonly unknown[], modes: readonly Mode[]): string[] {
  const known = new Set(modes.flatMap((mode) => [mode.enter, mode.leave]))
  const last = messages.map(soleText).findLast((text) => text !== undefined && known.has(text))
  const current = modes.find((mode) => mode.id === agent)
  const active = modes.find((mode) => mode.enter === last)
  if (active === current) return []
  return [...(active ? [leaveReminder(active)] : []), ...(current ? [enterReminder(current)] : [])]
}

/**
 * Where to add corrections: before a trailing real user prompt, else after the history (so
 * after any trailing reminders, which keeps the newest reminder last and reconciliation idempotent).
 */
export function insertionIndex(messages: readonly unknown[], modes: readonly Mode[]): number {
  const last = messages.at(-1)
  if ((last as { role?: unknown } | undefined)?.role !== "user") return messages.length
  const text = soleText(last)
  const reminder = text !== undefined && modes.some((mode) => mode.enter === text || mode.leave === text)
  return reminder ? messages.length : messages.length - 1
}

type SwitchEvent = { type?: unknown; data?: { sessionID?: unknown; agent?: unknown; previous?: unknown } }

/** Options for {@link registerModeReminders}. */
export type ModeReminderOptions = {
  /** Called when a synthetic message cannot be stored; the default ignores it. */
  onError?: (error: unknown) => void
}

/**
 * Wire reminders for `modes` into a plugin context: a synthetic message on `session.created`
 * and `session.agent.selected`, and a per-request reconcile in the `context` hook. Returns a
 * disposer for every registration.
 */
export async function registerModeReminders(
  ctx: Context,
  modes: readonly Mode[],
  options: ModeReminderOptions = {},
): Promise<() => Promise<void>> {
  const controller = new AbortController()
  const report = options.onError ?? (() => {})
  const synthetic = (sessionID: string, text: string) =>
    ctx.session.synthetic({ sessionID, text, resume: false } as never).catch(report)

  const hook = await ctx.session.hook("context", async (event) => {
    // A payload without a history has nothing to reconcile.
    if (!Array.isArray(event.messages)) return
    const missing = missingReminders(event.agent as string, event.messages, modes)
    if (missing.length === 0) return
    const at = insertionIndex(event.messages, modes)
    event.messages.splice(at, 0, ...missing.map((text) => ({ role: "user", content: [{ type: "text", text }] }) as never))
    for (const text of missing) await synthetic(event.sessionID as string, text)
  })

  void (async () => {
    for await (const raw of ctx.event.subscribe({
      types: ["session.created", "session.agent.selected"],
      signal: controller.signal,
    } as never)) {
      if (controller.signal.aborted) break
      const event = raw as SwitchEvent
      const data = event.data
      if (typeof data?.sessionID !== "string" || typeof data.agent !== "string") continue
      const previous = event.type === "session.created" ? undefined : (data.previous as string | undefined)
      for (const text of reminderFor(previous, data.agent, modes)) await synthetic(data.sessionID, text)
    }
  })().catch(report)

  return async () => {
    controller.abort()
    await hook.dispose()
  }
}
