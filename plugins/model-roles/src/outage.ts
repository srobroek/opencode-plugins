/**
 * When a failure is worth a note, and which text. A provider-wide failure class (auth,
 * credentials, quota, outage) is one provider outage: one note when it starts, one line per
 * stopped subagent session, one note when the first call succeeds again. A per-model failure
 * is rate limited per (parent session, model, class). Pure over an explicit state.
 */

import { failureNote, type NoteFacts } from "./fallback.ts"
import { type FailureClass, failureScope, healthKey } from "./health.ts"
import type { ModelRef } from "./resolve.ts"

/** A model's failure notice repeats at most once in this window. */
export const NOTICE_DEDUPE_MS = 60_000

/** An outage whose failures stopped this long ago and never saw a success is announced afresh. */
export const OUTAGE_STALE_MS = 15 * 60_000

type Stopped = { agent: string | undefined; sessionID: string | undefined }

type Outage = {
  providerID: string
  kind: FailureClass
  /** The last failure of the outage. */
  lastAt: number
  /** The session that heard the outage start; the recovery goes there too. */
  notifyTo: string
  stopped: Map<string, Stopped>
}

export type NoticeState = {
  /** Open outages by `provider\0class`. */
  outages: Map<string, Outage>
  /** When a model failure last notified, by `session\0model\0class`. */
  notices: Map<string, number>
}

export const newNoticeState = (): NoticeState => ({ outages: new Map(), notices: new Map() })

export type FailureReport = NoteFacts & {
  now: number
  /** The session the note goes to: the failed session, or a subagent's parent. */
  notifyTo: string
  /** Set when the failed session is a subagent. */
  subagent?: { agent: string | undefined; sessionID: string | undefined }
  /** The note for a failure of just this model; defaults to the plain model note. */
  plain?: string
}

export type Notice = { sessionID: string; text: string }

const stoppedKey = (report: FailureReport): string =>
  report.subagent?.sessionID ?? `${report.notifyTo}\0${report.subagent?.agent ?? ""}`

const stoppedLine = (stopped: Stopped, provider: string, kind: FailureClass, first: boolean): string => {
  const who = stopped.agent === undefined ? "A subagent" : `Subagent '${stopped.agent}'`
  const retry = stopped.sessionID === undefined ? "spawn it again" : `resume it with sessionID ${stopped.sessionID}`
  return first ? `${who} stopped: ${retry} when the provider is back.` : `${who} stopped by the ${provider} outage (${kind}): ${retry} when the provider is back.`
}

/** The note a failure earns, if any. Updates `state`. */
export function decideFailureNotice(state: NoticeState, report: FailureReport): Notice | undefined {
  const { failed, kind, now, notifyTo } = report
  if (failureScope(kind) === "provider") return decideOutage(state, report)
  const key = `${notifyTo}\0${healthKey(failed)}\0${kind}`
  const last = state.notices.get(key)
  if (last !== undefined && now - last < NOTICE_DEDUPE_MS) return undefined
  state.notices.set(key, now)
  return { sessionID: notifyTo, text: report.plain ?? failureNote(report) }
}

/** The recovery note names this many stopped sessions and counts the rest ("+N more"). */
export const MAX_STOPPED = 20

/**
 * Stopped sessions an outage remembers, so a repeat failure of a child is not announced again.
 * Past it the oldest are forgotten, so an outage that keeps failing new children stays bounded.
 */
export const MAX_TRACKED = 500

/** Whether `id` is new to the outage; it is remembered either way. */
function remember(outage: Outage, id: string, stopped: Stopped): boolean {
  if (outage.stopped.has(id)) return false
  outage.stopped.set(id, stopped)
  if (outage.stopped.size > MAX_TRACKED) outage.stopped.delete(outage.stopped.keys().next().value as string)
  return true
}

function decideOutage(state: NoticeState, report: FailureReport): Notice | undefined {
  const { failed, kind, now, notifyTo } = report
  const provider = failed.providerID
  const key = `${provider}\0${kind}`
  const found = state.outages.get(key)
  const outage: Outage = found ?? { providerID: provider, kind, lastAt: now, notifyTo, stopped: new Map() }
  // A quiet outage is announced again, but keeps its resume list and dedupe state.
  const announce = found === undefined || now - found.lastAt >= OUTAGE_STALE_MS
  state.outages.set(key, outage)
  outage.lastAt = now
  let line: string | undefined
  if (report.subagent !== undefined) {
    const stopped = { agent: report.subagent.agent, sessionID: report.subagent.sessionID }
    if (remember(outage, stoppedKey(report), stopped)) line = stoppedLine(stopped, provider, kind, announce)
  }
  if (!announce) return line === undefined ? undefined : { sessionID: notifyTo, text: line }
  outage.notifyTo = notifyTo
  const phase = report.cooldownMs > 0 ? "down" : "failing"
  const head = `Provider ${provider} is ${phase} (${kind}). ${failureNote(report)}`
  return { sessionID: notifyTo, text: line === undefined ? head : `${head} ${line}` }
}

/** A session was deleted or has run successfully since: it no longer needs resuming. */
export function forgetSession(state: NoticeState, sessionID: string): void {
  for (const outage of state.outages.values()) {
    outage.stopped.delete(sessionID)
  }
}

/** The recovery notes for a call that succeeded on `model`: every open outage of its provider ends. */
export function decideRecovery(state: NoticeState, model: Pick<ModelRef, "providerID">): Notice[] {
  const notices: Notice[] = []
  for (const [key, outage] of state.outages) {
    if (outage.providerID !== model.providerID) continue
    state.outages.delete(key)
    let text = `Provider ${outage.providerID} recovered (${outage.kind}).`
    const resumable = [...outage.stopped.values()].filter((s) => s.sessionID !== undefined)
    if (resumable.length > 0) {
      const list = resumable.slice(0, MAX_STOPPED).map((s) => `${s.agent ?? "subagent"} (${s.sessionID})`)
      if (resumable.length > MAX_STOPPED) list.push(`+${resumable.length - MAX_STOPPED} more`)
      text += ` Resume the stopped subagents: ${list.join(", ")}.`
    }
    notices.push({ sessionID: outage.notifyTo, text })
  }
  return notices
}

/** A model request that may still be running, by session, in order. */
export type RequestLog = Map<string, Array<{ at: number; model: ModelRef }>>

/** Requests kept per session; a session runs one at a time, so only a backlog of unhandled ends grows it. */
const MAX_REQUESTS = 8

export function recordRequest(log: RequestLog, sessionID: string, model: ModelRef, at: number): void {
  const list = log.get(sessionID) ?? []
  list.push({ at, model: { providerID: model.providerID, id: model.id } })
  if (list.length > MAX_REQUESTS) list.shift()
  log.set(sessionID, list)
}

/**
 * The model of the request that an execution ending at `endedAt` ran: the session's latest
 * request started before then. That request and every earlier one are consumed; later requests
 * belong to later executions and stay. The host's end events carry only the session and a
 * timestamp, so the time is the only link between an end and its request.
 */
export function settleRequest(log: RequestLog, sessionID: string, endedAt: number): ModelRef | undefined {
  const list = log.get(sessionID)
  if (list === undefined) return undefined
  // Strict: a request's own end comes after its response, so one at the end's millisecond is the next execution's.
  const done = list.filter((entry) => entry.at < endedAt)
  const rest = list.filter((entry) => entry.at >= endedAt)
  if (rest.length > 0) log.set(sessionID, rest)
  else log.delete(sessionID)
  return done.at(-1)?.model
}
