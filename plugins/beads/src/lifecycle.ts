/**
 * What the beads plugin does when a session's execution ends.
 *
 * - A root session that stops with tracked claims is nudged once, with the guarded
 *   release commands, and continues (`synthetic`, `resume: true`). A real user prompt
 *   re-arms the nudge. While OpenCode's built-in goal is active the nudge stands down: the
 *   goal may continue the session. The stop is deferred, and runs again as a clean stop
 *   when the goal ends (`rpc.opencode.goal.changed`) unless a new execution starts first.
 * - A root session that stops again, still holding them, gets them released.
 * - A subagent's claims are released when it succeeds or is deleted, held or not. A failed or interrupted
 *   subagent keeps them, because it can be resumed. A foreground subagent's release
 *   is reported in its `subagent` tool result; a background one's in a synthetic message
 *   to its parent, which does not wake the parent. A background subagent that goes idle
 *   with its own background work still running keeps its claims and leases until its final
 *   idle, its deletion or `BACKGROUND_HOLD_MS`, whichever comes first. Work only a
 *   descendant owns does not hold them: it wakes the descendant, not the subagent.
 * - Lease heartbeats pause when an execution ends and resume when the next one starts.
 */

import type { Context } from "@opencode/plugin/promise/plugin"
import type { Result } from "@opencode/plugin/promise/tool"
import {
  BACKGROUND_HOLD_MS,
  type HoldTimer,
  type IdleReport,
  IdleReports,
  SYSTEM_HOLD_TIMER,
} from "@srobroek/opencode-lib/idle-background"
import { type ClaimState, readClaimState, type TrackedClaim } from "./claims.ts"
import type { BdRun } from "./gate-admission.ts"
import { GOAL_SOURCE, isGoalActive } from "./goal.ts"
import { type Heartbeats, readLeases } from "./heartbeat.ts"
import {
  MAX_RETAINED_SCOPES,
  mergeClaims,
  type ReconcileScope,
  readReconcileScope,
  reconcileHeld,
  withStores,
} from "./reconcile.ts"
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

/**
 * Whether a subagent's execution end finishes it. A failure (a provider outage, say) or an
 * interrupt leaves it resumable, so it keeps its claims: another agent must not take the bead.
 */
export function childFinished(end: ExecutionEnd): boolean {
  return end.kind === "succeeded"
}

/** True for prompt metadata this plugin or the built-in goal wrote, which is not the user speaking. */
export function isPluginPrompt(metadata: unknown): boolean {
  const source = (metadata as { source?: unknown } | null | undefined)?.source
  return source === BEADS_SOURCE || source === GOAL_SOURCE
}

/** Whether a goal `changed` event ends the deferral of a stop: the goal has stopped driving the session. */
export function goalEnded(goal: unknown): boolean {
  return !isGoalActive(goal)
}

export const GOAL_CHANGED = "rpc.opencode.goal.changed"

type ExecutionEvent = {
  id?: string
  type: string
  sessionID: string
  end?: ExecutionEnd
  goal?: unknown
  /** When the host published the event, which pairs an end with the idle reports before it. */
  created?: number
}

/** The parts of an event the lifecycle reads, or `undefined` for every other event. */
export function readExecutionEvent(event: unknown): ExecutionEvent | undefined {
  const record = event as { id?: unknown; type?: unknown; created?: unknown; data?: { sessionID?: unknown; reason?: unknown; goal?: unknown } } | null
  const type = record?.type
  const sessionID = record?.data?.sessionID
  if (typeof type !== "string" || typeof sessionID !== "string") return undefined
  const id = typeof record?.id === "string" ? record.id : undefined
  const at = typeof record?.created === "number" && Number.isFinite(record.created) ? { created: record.created } : {}
  switch (type) {
    case "session.execution.started":
    case "session.deleted":
      return { id, type, sessionID }
    case GOAL_CHANGED:
      return { id, type, sessionID, goal: record?.data?.goal }
    case "session.execution.succeeded":
      return { id, type, sessionID, end: { kind: "succeeded" }, ...at }
    case "session.execution.failed":
      return { id, type, sessionID, end: { kind: "failed" }, ...at }
    case "session.execution.interrupted": {
      const reason = record?.data?.reason
      return { id, type, sessionID, end: { kind: "interrupted", reason: typeof reason === "string" ? reason : undefined }, ...at }
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
  /** Root sessions whose stop stood down for an active goal, awaiting the goal's end. */
  deferred: Set<string>
  /** Foreground `subagent` calls in flight, by parent session. */
  foreground: Map<string, Set<string>>
  /** Child releases in flight. */
  releases: Map<string, Promise<ChildRelease | undefined>>
  /** Releases a foreground tool result reports, so the child's own end does not report them again. */
  reported: WeakSet<Promise<ChildRelease | undefined>>
  /** Each session's last idle report: whether it still had background work running. */
  idle: IdleReports
  /** Subagents that went idle with background work still running, whose release waits for their final idle. */
  held: Map<string, Hold>
  /** The identity of each session's latest run; a release belongs to the run that ended. */
  runs: Map<string, number>
  /** The last run identity issued. Identities are never reused, so an evicted one cannot match a later run. */
  issued: { last: number }
  /** A run that ended successfully while an earlier release of its session was still running. */
  pending: Map<string, number>
}

type Hold = { parentID: string; owner: Lifecycle; timer: unknown }

const SHARED: unique symbol = Symbol.for("srobroek.beads.lifecycle") as never

/** State every instance of this plugin in the process shares, so one event is handled once. */
function shared(): Shared {
  const holder = globalThis as { [SHARED]?: Partial<Shared> }
  // An older instance of this plugin in the same process may have created the object
  // without the fields a later version added, so each field is backfilled on its own.
  holder[SHARED] ??= {}
  const state = holder[SHARED]
  state.events ??= new Set()
  state.deferred ??= new Set()
  state.foreground ??= new Map()
  state.releases ??= new Map()
  state.reported ??= new WeakSet()
  state.idle ??= new IdleReports()
  state.held ??= new Map()
  state.runs ??= new Map()
  state.issued ??= { last: 0 }
  state.pending ??= new Map()
  return state as Shared
}

/** A session lookup; `known` is false when the host could not report the session. */
type Resolved = { known: boolean; parentID: string | undefined }

type ChildRelease = {
  claims: Record<string, TrackedClaim>
  outcome: ReleaseOutcome
  /** Stores whose in-progress list could not be read, and why. */
  unlisted: Array<{ store: string; failure: string }>
}

export type LifecycleDeps = {
  ctx: Context
  run: BdRun
  env: () => NodeJS.ProcessEnv
  queue: <T>(key: string, task: () => Promise<T>) => Promise<T>
  heartbeats: Heartbeats
  nudge: boolean
  release: boolean
  /** The session's built-in goal state; a rejection counts as no goal. */
  goal: (sessionID: string) => Promise<unknown>
  /** Receives every detached task; tests join them. */
  detach: (task: Promise<unknown>) => void
  /** The timer behind `BACKGROUND_HOLD_MS`; defaults to the system timer. */
  holdTimer?: HoldTimer
  /** How many sessions' run identities are retained; defaults to `MAX_EVENTS`. */
  maxRuns?: number
}

const MAX_EVENTS = 2_000

/** Storage key of the ids whose reconcile records are retained, oldest first. */
const SCOPE_INDEX = "reconcile-index"

const readIndex = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [])

export class Lifecycle {
  readonly #deps: LifecycleDeps
  readonly #parents = new Map<string, Promise<Resolved>>()
  #casSupported = true

  constructor(deps: LifecycleDeps) {
    this.#deps = deps
  }

  /** The parent of `sessionID`, or `undefined` for a root session or one the host cannot report. */
  async parentOf(sessionID: string): Promise<string | undefined> {
    return (await this.#resolve(sessionID)).parentID
  }

  /** A resumed child must not claim under the same actor until its old release has settled. */
  async awaitRelease(sessionID: string): Promise<void> {
    let task = shared().releases.get(sessionID)
    while (task !== undefined) {
      await task
      task = shared().releases.get(sessionID)
    }
  }

  #resolve(sessionID: string): Promise<Resolved> {
    let resolved = this.#parents.get(sessionID)
    if (resolved === undefined) {
      resolved = (this.#deps.ctx.session.get({ sessionID } as never) as Promise<{ parentID?: string | null }>).then(
        (session): Resolved => ({
          known: session != null,
          parentID: typeof session?.parentID === "string" && session.parentID !== "" ? session.parentID : undefined,
        }),
        (): Resolved => ({ known: false, parentID: undefined }),
      )
      this.#parents.set(sessionID, resolved)
    }
    return resolved
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
    if (event.type === GOAL_CHANGED) {
      if (!shared().deferred.has(sessionID) || !goalEnded(event.goal)) return
      shared().deferred.delete(sessionID)
      if ((await this.parentOf(sessionID)) === undefined) await this.#rootStop(sessionID, { kind: "succeeded" }, false)
      return
    }
    if (event.type === "session.execution.started") {
      const runs = shared().runs
      runs.set(sessionID, ++shared().issued.last)
      if (runs.size > (this.#deps.maxRuns ?? MAX_EVENTS)) {
        // A session with an outstanding or pending release keeps its identity, so that release never reads the 0 fallback.
        const evictable = [...runs.keys()].find((id) => !shared().releases.has(id) && !shared().pending.has(id))
        if (evictable !== undefined) runs.delete(evictable)
      }
      shared().deferred.delete(sessionID)
      // A held child woke up; its next end decides its claims.
      this.#unhold(sessionID)
      const leases = readLeases(await this.#deps.ctx.storage.get(`leases/${sessionID}`))
      this.#deps.heartbeats.run(sessionID, leases, true)
      return
    }
    if (event.type === "session.deleted") {
      shared().idle.forget(sessionID)
      const hold = this.#unhold(sessionID)
      this.#deps.heartbeats.pause(sessionID)
      await this.#deps.ctx.storage.remove(`leases/${sessionID}`)
      await this.#deps.ctx.storage.remove(`nudged/${sessionID}`)
      // Resolve the parent before its cache entry goes: a deleted child can no longer be looked up.
      const resolved = hold === undefined ? await this.#resolve(sessionID) : { known: true, parentID: hold.parentID }
      const { parentID } = resolved
      this.#parents.delete(sessionID)
      shared().deferred.delete(sessionID)
      // Deletion ends a child for good, held or not: whatever claims it kept for a resume are released.
      if (parentID !== undefined) this.#childEnd(sessionID, parentID, { kind: "succeeded" })
      // The host could not say whether this was a child (not cached, lookup failed): release by its own session ID,
      // which touches only claims tracked under it. A known root keeps its claims, as before.
      else if (!resolved.known && this.#deps.release) this.#deps.detach(this.#releaseChild(sessionID, Date.now() + RELEASE_CEILING_MS))
      return
    }
    if (event.end === undefined) return
    // Evidence lost past the report cap counts as work still running: holding is the safe side.
    const working = shared().idle.take(sessionID, event.created) !== "done"
    const parentID = await this.parentOf(sessionID)
    // Its background work's notice wakes the child again: its claims and leases stay until its final idle.
    if (parentID !== undefined && working && event.end.kind === "succeeded" && this.#deps.release) {
      this.#hold(sessionID, parentID)
      return
    }
    this.#unhold(sessionID)
    this.#deps.heartbeats.pause(sessionID)
    if (parentID === undefined) await this.#rootStop(sessionID, event.end)
    else this.#childEnd(sessionID, parentID, event.end)
  }

  /** Record the background work a session's `experimental.idle` hook reports. */
  idle(event: IdleReport): void {
    shared().idle.record(event)
  }

  /** Stop the hold timers this instance started; their children keep their claims. */
  dispose(): void {
    for (const [sessionID, hold] of shared().held) if (hold.owner === this) this.#unhold(sessionID)
  }

  #hold(sessionID: string, parentID: string): void {
    this.#unhold(sessionID)
    const timer = (this.#deps.holdTimer ?? SYSTEM_HOLD_TIMER).setTimeout(() => {
      if (shared().held.get(sessionID)?.timer !== timer) return
      shared().held.delete(sessionID)
      this.#deps.heartbeats.pause(sessionID)
      this.#childEnd(sessionID, parentID, { kind: "succeeded" })
    }, BACKGROUND_HOLD_MS)
    shared().held.set(sessionID, { parentID, owner: this, timer })
  }

  #unhold(sessionID: string): Hold | undefined {
    const hold = shared().held.get(sessionID)
    if (hold === undefined) return undefined
    shared().held.delete(sessionID)
    ;(hold.owner.#deps.holdTimer ?? SYSTEM_HOLD_TIMER).clearTimeout(hold.timer)
    return hold
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
      : releaseReport(`finished subagent session ${child.sessionID}`, released.claims, released.outcome, undefined, released.unlisted)
  }

  async #rootStop(sessionID: string, end: ExecutionEnd, checkGoal = true): Promise<void> {
    if (!this.#deps.nudge) return
    const storage = this.#deps.ctx.storage
    const continuing = checkGoal && end.kind === "succeeded" && (await this.#goalActive(sessionID))
    const action = await this.#deps.queue(`stop/${sessionID}`, async () => {
      const state = readClaimState(await storage.get(`claims/${sessionID}`))
      const next = rootStopAction(end, {
        claims: Object.keys(state.claims).length,
        nudged: (await storage.get(`nudged/${sessionID}`)) === true,
        continuing,
      })
      if (next === "nudge") await storage.set(`nudged/${sessionID}`, true)
      if (continuing && rootStopAction(end, { claims: Object.keys(state.claims).length, nudged: false, continuing: false }) !== "none")
        shared().deferred.add(sessionID)
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

  async #goalActive(sessionID: string): Promise<boolean> {
    try {
      return isGoalActive(await this.#deps.goal(sessionID))
    } catch {
      return false
    }
  }

  #childEnd(sessionID: string, parentID: string, end: ExecutionEnd): void {
    if (!this.#deps.release || !childFinished(end)) return
    this.#deps.detach(
      (async () => {
        const run = this.#run(sessionID)
        const storage = this.#deps.ctx.storage
        const background = (await storage.get(`background/${sessionID}`)) === parentID
        // A foreground child's release is settled and reported by its parent's tool result.
        if (!background && (shared().foreground.get(parentID)?.size ?? 0) > 0) return
        const task = this.#releaseChild(sessionID, Date.now() + RELEASE_CEILING_MS, run)
        const released = await task
        if (released === undefined || shared().reported.has(task)) return
        const text = releaseReport(`finished background subagent session ${sessionID}`, released.claims, released.outcome, undefined, released.unlisted)
        if (text !== undefined) await this.#send(parentID, text, false, "subagent-release")
      })(),
    )
  }

  /** The identity of `sessionID`'s latest run, or 0 (never issued) when it has none or it was evicted. */
  #run(sessionID: string): number {
    return shared().runs.get(sessionID) ?? 0
  }

  /** Release a finished child's claims; `ended` is the run that ended, which a later resume outdates. */
  #releaseChild(sessionID: string, deadline: number, ended = this.#run(sessionID)): Promise<ChildRelease | undefined> {
    const releases = shared().releases
    const running = releases.get(sessionID)
    if (running !== undefined) {
      // A run that ended while an earlier release was running is released once that one finishes.
      if (ended !== 0) shared().pending.set(sessionID, ended)
      return running
    }
    const task: Promise<ChildRelease | undefined> = this.#releaseThenPending(sessionID, deadline, ended).finally(() => {
      if (releases.get(sessionID) === task) releases.delete(sessionID)
    })
    releases.set(sessionID, task)
    return task
  }

  /** Release for `ended`, then for the newest run that ended meanwhile, until none is left. */
  async #releaseThenPending(sessionID: string, deadline: number, ended: number): Promise<ChildRelease | undefined> {
    const pending = shared().pending
    let result = await this.#release(sessionID, deadline, ended)
    let next = pending.get(sessionID)
    while (next !== undefined) {
      pending.delete(sessionID)
      if (next !== ended) result = (await this.#release(sessionID, Date.now() + RELEASE_CEILING_MS, next)) ?? result
      ended = next
      next = pending.get(sessionID)
    }
    // Leave in the same turn as the last look at `pending`: a run that ends after this starts its own release.
    shared().releases.delete(sessionID)
    return result
  }

  /** Drop a subagent's reconcile record and its place in the retention index. */
  async #forgetScope(sessionID: string): Promise<void> {
    const { ctx, queue } = this.#deps
    await ctx.storage.remove(`reconcile/${sessionID}`)
    await queue(SCOPE_INDEX, async () => {
      const index = readIndex(await ctx.storage.get(SCOPE_INDEX))
      if (index.includes(sessionID)) await ctx.storage.set(SCOPE_INDEX, index.filter((id) => id !== sessionID))
    })
  }

  /** Note the actor and stores a subagent's shell calls ran under, so its end can ask bd what it still holds. */
  async recordScope(sessionID: string, actor: string, stores: readonly string[]): Promise<void> {
    if (!this.#deps.release) return
    const key = `reconcile/${sessionID}`
    await this.#deps.queue(key, async () => {
      const stored = readReconcileScope(await this.#deps.ctx.storage.get(key))
      const next = withStores(stored, actor, stores)
      if (next !== stored) await this.#deps.ctx.storage.set(key, next)
    })
    // Records of children that never complete a cleanup (failed, never deleted) are capped, oldest first.
    const evicted = await this.#deps.queue(SCOPE_INDEX, async () => {
      const index = readIndex(await this.#deps.ctx.storage.get(SCOPE_INDEX))
      if (index.includes(sessionID)) return []
      const next = [...index, sessionID]
      const dropped = next.splice(0, Math.max(0, next.length - MAX_RETAINED_SCOPES))
      await this.#deps.ctx.storage.set(SCOPE_INDEX, next)
      return dropped
    })
    for (const id of evicted) await this.#deps.ctx.storage.remove(`reconcile/${id}`)
  }

  /**
   * Release `sessionID`'s claims and forget the ones that are no longer held. For a child, the
   * claims bd lists under its actor join the tracked ones, so a claim the tracker missed is released too.
   */
  async #release(sessionID: string, deadline: number, ended?: number): Promise<ChildRelease | undefined> {
    const child = ended !== undefined
    const { ctx, queue, run, env, heartbeats } = this.#deps
    const key = `claims/${sessionID}`
    const state: ClaimState = readClaimState(await ctx.storage.get(key))
    let claims = { ...state.claims }
    const scope: ReconcileScope | undefined = child ? readReconcileScope(await ctx.storage.get(`reconcile/${sessionID}`)) : undefined
    const unlisted: ChildRelease["unlisted"] = []
    if (scope !== undefined) {
      const found = await reconcileHeld(scope, run, deadline, env())
      claims = mergeClaims(claims, found.claims)
      unlisted.push(...found.failures)
    }
    if (Object.keys(claims).length === 0 && unlisted.length === 0) return undefined
    // A child that resumed while this ran owns its claims again; only its next end releases them.
    const stale = () => child && this.#run(sessionID) !== ended
    const outcome = await releaseClaims(Object.entries(claims), run, deadline, env(), this.#casSupported, undefined, stale)
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
    const complete = outcome.unverified.length === 0 && unlisted.length === 0 && Object.keys(claims).every((claimKey) => gone.has(claimKey))
    if (scope !== undefined && complete)
      await queue(`reconcile/${sessionID}`, async () => {
        if (!stale()) await this.#forgetScope(sessionID)
      })
    return { claims, outcome, unlisted }
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
