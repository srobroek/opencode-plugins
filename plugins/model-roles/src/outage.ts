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

function decideOutage(state: NoticeState, report: FailureReport): Notice | undefined {
  const { failed, kind, now, notifyTo } = report
  const key = `${failed.providerID}\0${kind}`
  const open = state.outages.get(key)
  if (open !== undefined && now - open.lastAt < OUTAGE_STALE_MS) {
    open.lastAt = now
    if (report.subagent === undefined) return undefined
    const id = stoppedKey(report)
    if (open.stopped.has(id)) return undefined
    const stopped = { agent: report.subagent.agent, sessionID: report.subagent.sessionID }
    open.stopped.set(id, stopped)
    return { sessionID: notifyTo, text: stoppedLine(stopped, failed.providerID, kind, false) }
  }
  const outage: Outage = { providerID: failed.providerID, kind, lastAt: now, notifyTo, stopped: new Map() }
  state.outages.set(key, outage)
  const phase = report.cooldownMs > 0 ? "down" : "failing"
  let text = `Provider ${failed.providerID} is ${phase} (${kind}). ${failureNote(report)}`
  if (report.subagent !== undefined) {
    const stopped = { agent: report.subagent.agent, sessionID: report.subagent.sessionID }
    outage.stopped.set(stoppedKey(report), stopped)
    text += ` ${stoppedLine(stopped, failed.providerID, kind, true)}`
  }
  return { sessionID: notifyTo, text }
}

/** The recovery notes for a call that succeeded on `model`: every open outage of its provider ends. */
export function decideRecovery(state: NoticeState, model: Pick<ModelRef, "providerID">): Notice[] {
  const notices: Notice[] = []
  for (const [key, outage] of state.outages) {
    if (outage.providerID !== model.providerID) continue
    state.outages.delete(key)
    let text = `Provider ${outage.providerID} recovered (${outage.kind}).`
    const resumable = [...outage.stopped.values()].filter((s) => s.sessionID !== undefined)
    if (resumable.length > 0) text += ` Resume the stopped subagents: ${resumable.map((s) => `${s.agent ?? "subagent"} (${s.sessionID})`).join(", ")}.`
    notices.push({ sessionID: outage.notifyTo, text })
  }
  return notices
}
