/**
 * What the beads plugin does when a session's execution ends.
 *
 * - A root session that stops with tracked claims is nudged once, with the guarded
 *   release commands, and continues (`synthetic`, `resume: true`). A real user prompt
 *   re-arms the nudge. While the goal plugin will continue the session, the nudge stands
 *   down: the goal turn is not a stop.
 * - A root session that stops again, still holding them, gets them released.
 * - A subagent's claims are released when it finishes. A foreground subagent's release
 *   is reported in its `subagent` tool result; a background one's in a synthetic message
 *   to its parent, which does not wake the parent.
 * - Lease heartbeats pause when an execution ends and resume when the next one starts.
 */

import type { Context } from "@opencode/plugin/promise/plugin"
import type { Result } from "@opencode/plugin/promise/tool"
import { type ClaimState, readClaimState, type TrackedClaim } from "./claims.ts"
import type { BdRun } from "./gate-admission.ts"
import { type Heartbeats, readLeases } from "./heartbeat.ts"
import { heldClaimsAdvisory, RELEASE_CEILING_MS, type ReleaseOutcome, releaseClaims, releaseReport } from "./release.ts"

/** `metadata.source` on every message this plugin sends. */
export const BEADS_SOURCE = "srobroek.beads"

/** How long a foreground subagent's release may hold up its parent's tool result. */
export const FOREGROUND_RELEASE_MS = 25_000

export type ExecutionEnd =
  | { kind: "succeeded" }
  | { kind: "failed" }
  | { kind: "interrupted"; reason: string | undefined }

export type RootStopState = { claims: number; nudged: boolean; continuing: boolean }

/** What a root session's stop calls for. Only a clean stop counts; a user interrupt or a failure does not. */
export function rootStopAction(end: ExecutionEnd, state: RootStopState): "none" | "nudge" | "release" {
  if (end.kind !== "succeeded" || state.claims === 0 || state.continuing) return "none"
  return state.nudged ? "release" : "nudge"
}

/** Whether a subagent's execution end finishes it. A superseded execution continues. */
export function childFinished(end: ExecutionEnd): boolean {
  return end.kind !== "interrupted" || end.reason !== "superseded"
}

/** True for prompt metadata this plugin or the goal plugin wrote, which is not the user speaking. */
export function isPluginPrompt(metadata: unknown): boolean {
  const source = (metadata as { source?: unknown } | null | undefined)?.source
  return source === BEADS_SOURCE || source === "srobroek.goal"
}

/** The goal plugin's continuation for `sessionID`, read from its process-wide registry without importing it. */
export function goalContinuation(sessionID: string): string | undefined {
  const holder = globalThis as { [key: symbol]: unknown }
  const registry = holder[Symbol.for("srobroek.goal.continuations")]
  return registry instanceof Map ? (registry.get(sessionID) as string | undefined) : undefined
}

type ExecutionEvent = { id?: string; type: string; sessionID: string; end?: ExecutionEnd }

/** The parts of an event the lifecycle reads, or `undefined` for every other event. */
export function readExecutionEvent(event: unknown): ExecutionEvent | undefined {
  const record = event as { id?: unknown; type?: unknown; data?: { sessionID?: unknown; reason?: unknown } } | null
  const type = record?.type
  const sessionID = record?.data?.sessionID
  if (typeof type !== "string" || typeof sessionID !== "string") return undefined
  const id = typeof record?.id === "string" ? record.id : undefined
  switch (type) {
    case "session.execution.started":
    case "session.deleted":
      return { id, type, sessionID }
    case "session.execution.succeeded":
      return { id, type, sessionID, end: { kind: "succeeded" } }
    case "session.execution.failed":
      return { id, type, sessionID, end: { kind: "failed" } }
    case "session.execution.interrupted": {
      const reason = record?.data?.reason
      return { id, type, sessionID, end: { kind: "interrupted", reason: typeof reason === "string" ? reason : undefined } }
    }
  }
  return undefined
}

/** The child session a `subagent` result names, and whether it runs in the background. */
export function subagentChild(result: Result | undefined): { sessionID: string; background: boolean } | undefined {
  for (const source of [result?.metadata, result?.output]) {
    const record = source as { sessionID?: unknown; status?: unknown } | null | undefined
    if (typeof record?.sessionID === "string" && record.sessionID !== "")
      return { sessionID: record.sessionID, background: record.status === "running" }
  }
  return undefined
}

type Shared = {
  /** Event ids already handled by some instance of this plugin. */
  events: Set<string>
  /** Foreground `subagent` calls in flight, by parent session. */
  foreground: Map<string, Set<string>>
  /** Child releases in flight. */
  releases: Map<string, Promise<ChildRelease | undefined>>
  /** Releases a foreground tool result reports, so the child's own end does not report them again. */
  reported: WeakSet<Promise<ChildRelease | undefined>>
}

const SHARED: unique symbol = Symbol.for("srobroek.beads.lifecycle") as never

/** State every instance of this plugin in the process shares, so one event is handled once. */
function shared(): Shared {
  const holder = globalThis as { [SHARED]?: Shared }
  holder[SHARED] ??= { events: new Set(), foreground: new Map(), releases: new Map(), reported: new WeakSet() }
  return holder[SHARED]
}

type ChildRelease = { claims: Record<string, TrackedClaim>; outcome: ReleaseOutcome }

export type LifecycleDeps = {
  ctx: Context
  run: BdRun
  env: () => NodeJS.ProcessEnv
  queue: <T>(key: string, task: () => Promise<T>) => Promise<T>
  heartbeats: Heartbeats
  nudge: boolean
  release: boolean
  /** Receives every detached task; tests join them. */
  detach: (task: Promise<unknown>) => void
}

const MAX_EVENTS = 2_000

export class Lifecycle {
  readonly #deps: LifecycleDeps
  readonly #parents = new Map<string, Promise<string | undefined>>()
  #casSupported = true

  constructor(deps: LifecycleDeps) {
    this.#deps = deps
  }

  /** The parent of `sessionID`, or `undefined` for a root session. */
  parentOf(sessionID: string): Promise<string | undefined> {
    let parent = this.#parents.get(sessionID)
    if (parent === undefined) {
      parent = (this.#deps.ctx.session.get({ sessionID } as never) as Promise<{ parentID?: string | null }>).then(
        (session) => (typeof session?.parentID === "string" && session.parentID !== "" ? session.parentID : undefined),
        () => undefined,
      )
      this.#parents.set(sessionID, parent)
    }
    return parent
  }

  async handleEvent(raw: unknown): Promise<void> {
    const event = readExecutionEvent(raw)
    if (event === undefined) return
    if (event.id !== undefined) {
      const seen = shared().events
      if (seen.has(event.id)) return
      seen.add(event.id)
      if (seen.size > MAX_EVENTS) seen.delete(seen.values().next().value as string)
    }
    const { sessionID } = event
    if (event.type === "session.execution.started") {
      const leases = readLeases(await this.#deps.ctx.storage.get(`leases/${sessionID}`))
      this.#deps.heartbeats.run(sessionID, leases, true)
      return
    }
    if (event.type === "session.deleted") {
      this.#deps.heartbeats.pause(sessionID)
      await this.#deps.ctx.storage.remove(`leases/${sessionID}`)
      await this.#deps.ctx.storage.remove(`nudged/${sessionID}`)
      this.#parents.delete(sessionID)
      return
    }
    if (event.end === undefined) return
    this.#deps.heartbeats.pause(sessionID)
    const parentID = await this.parentOf(sessionID)
    if (parentID === undefined) await this.#rootStop(sessionID, event.end)
    else this.#childEnd(sessionID, parentID, event.end)
  }

  /** A real user prompt re-arms the stop nudge. */
  async prompt(sessionID: string, metadata: unknown): Promise<void> {
    if (isPluginPrompt(metadata)) return
    await this.#deps.queue(`stop/${sessionID}`, () => this.#deps.ctx.storage.remove(`nudged/${sessionID}`))
  }

  subagentStarted(parentID: string, callID: string, input: unknown): void {
    if ((input as { background?: unknown } | null)?.background === true) return
    const calls = shared().foreground.get(parentID) ?? new Set<string>()
    calls.add(callID)
    shared().foreground.set(parentID, calls)
  }

  /** Settle a finished `subagent` call: returns text to append to its result, if any. */
  async subagentEnded(parentID: string, callID: string, result: Result | undefined): Promise<string | undefined> {
    const calls = shared().foreground.get(parentID)
    calls?.delete(callID)
    if (calls?.size === 0) shared().foreground.delete(parentID)
    const child = subagentChild(result)
    if (child === undefined || !this.#deps.release) return undefined
    if (child.background) {
      await this.#deps.ctx.storage.set(`background/${child.sessionID}`, parentID)
      return undefined
    }
    const task = this.#releaseChild(child.sessionID, Date.now() + FOREGROUND_RELEASE_MS)
    shared().reported.add(task)
    const released = await task
    return released === undefined
      ? undefined
      : releaseReport(`finished subagent session ${child.sessionID}`, released.claims, released.outcome)
  }

  async #rootStop(sessionID: string, end: ExecutionEnd): Promise<void> {
    if (!this.#deps.nudge) return
    const storage = this.#deps.ctx.storage
    const action = await this.#deps.queue(`stop/${sessionID}`, async () => {
      const state = readClaimState(await storage.get(`claims/${sessionID}`))
      const next = rootStopAction(end, {
        claims: Object.keys(state.claims).length,
        nudged: (await storage.get(`nudged/${sessionID}`)) === true,
        continuing: goalContinuation(sessionID) !== undefined,
      })
      if (next === "nudge") await storage.set(`nudged/${sessionID}`, true)
      return { next, state }
    })
    if (action.next === "nudge") {
      const text = heldClaimsAdvisory(action.state, this.#casSupported)
      if (text !== undefined) await this.#send(sessionID, text, true, "stop-nudge")
      return
    }
    if (action.next === "release" && this.#deps.release) {
      this.#deps.detach(
        this.#release(sessionID, Date.now() + RELEASE_CEILING_MS).then(async (released) => {
          if (released === undefined) return
          const text = releaseReport("this session", released.claims, released.outcome)
          if (text !== undefined) await this.#send(sessionID, text, false, "release")
        }),
      )
    }
  }

  #childEnd(sessionID: string, parentID: string, end: ExecutionEnd): void {
    if (!this.#deps.release || !childFinished(end)) return
    this.#deps.detach(
      (async () => {
        const storage = this.#deps.ctx.storage
        const background = (await storage.get(`background/${sessionID}`)) === parentID
        // A foreground child's release is settled and reported by its parent's tool result.
        if (!background && (shared().foreground.get(parentID)?.size ?? 0) > 0) return
        const task = this.#releaseChild(sessionID, Date.now() + RELEASE_CEILING_MS)
        const released = await task
        if (released === undefined || shared().reported.has(task)) return
        const text = releaseReport(`finished background subagent session ${sessionID}`, released.claims, released.outcome)
        if (text !== undefined) await this.#send(parentID, text, false, "subagent-release")
      })(),
    )
  }

  #releaseChild(sessionID: string, deadline: number): Promise<ChildRelease | undefined> {
    const releases = shared().releases
    const running = releases.get(sessionID)
    if (running !== undefined) return running
    const task = this.#release(sessionID, deadline).finally(() => releases.delete(sessionID))
    releases.set(sessionID, task)
    return task
  }

  /** Release `sessionID`'s tracked claims and forget the ones that are no longer held. */
  async #release(sessionID: string, deadline: number): Promise<ChildRelease | undefined> {
    const { ctx, queue, run, env, heartbeats } = this.#deps
    const key = `claims/${sessionID}`
    const state: ClaimState = readClaimState(await ctx.storage.get(key))
    const claims = { ...state.claims }
    if (Object.keys(claims).length === 0) return undefined
    const outcome = await releaseClaims(Object.entries(claims), run, deadline, env(), this.#casSupported)
    this.#casSupported = outcome.casSupported
    const gone = new Set([...outcome.released, ...outcome.dropped])
    await queue(key, async () => {
      const current = readClaimState(await ctx.storage.get(key))
      for (const [claimKey, claim] of Object.entries(current.claims)) {
        const was = claims[claimKey]
        if (gone.has(claimKey) && was !== undefined && was.id === claim.id && was.store === claim.store)
          delete current.claims[claimKey]
      }
      await ctx.storage.set(key, current)
      const leaseKey = `leases/${sessionID}`
      const leases = readLeases(await ctx.storage.get(leaseKey))
      for (const claimKey of gone) delete leases[claimKey]
      await ctx.storage.set(leaseKey, leases)
      if (Object.keys(leases).length === 0) heartbeats.pause(sessionID)
    })
    return { claims, outcome }
  }

  async #send(sessionID: string, text: string, resume: boolean, kind: string): Promise<void> {
    try {
      await this.#deps.ctx.session.synthetic({
        sessionID,
        text,
        delivery: "queue",
        resume,
        metadata: { source: BEADS_SOURCE, kind },
      } as never)
    } catch (error) {
      console.error("srobroek.beads: could not deliver a lifecycle message", error)
    }
  }
}
