/**
 * Lease heartbeats for the claims a session holds.
 *
 * bd keeps a claim lease for five minutes; `bd heartbeat <id>` renews it. While a session
 * executes, each claim with a known actor and store is renewed every minute. Between
 * executions the timers pause, so an idle or crashed session lets its leases lapse and
 * `bd reclaim` can hand the work on. The lease list is plain JSON in plugin storage; the
 * timers are process-wide, so two plugin instances never renew one lease twice.
 */

import { dirname } from "node:path"
import type { BdInvocation } from "./bd-actor-gate.ts"
import { beadIdCandidates, type ClaimState } from "./claims.ts"
import { type BdRun, parseTrailingJson } from "./gate-admission.ts"
import { claimEnvironment } from "./release.ts"

/** Renew at one fifth of bd's five-minute lease. */
export const HEARTBEAT_INTERVAL_MS = 60_000
/** One heartbeat must not occupy most of the next tick. */
export const HEARTBEAT_TIMEOUT_MS = 10_000

export type Lease = { id: string; actor: string; store: string }
export type Leases = Record<string, Lease>

/** Read stored leases back, dropping anything malformed. */
export function readLeases(value: unknown): Leases {
  const leases: Leases = {}
  if (value === null || typeof value !== "object") return leases
  for (const [key, lease] of Object.entries(value as Record<string, unknown>)) {
    if (lease === null || typeof lease !== "object") continue
    const l = lease as Record<string, unknown>
    if (typeof l.id === "string" && typeof l.actor === "string" && typeof l.store === "string")
      leases[key] = { id: l.id, actor: l.actor, store: l.store }
  }
  return leases
}

/**
 * Bead ids whose lease a successful command ends: a status other than `in_progress`.
 * Closing and unclaiming already drop the claim itself.
 */
export function leaseEndingIds(invocations: readonly BdInvocation[]): string[] {
  const ids = new Set<string>()
  for (const invocation of invocations) {
    if (invocation.verb !== "update") continue
    let status: string | undefined
    const named: string[] = []
    for (let index = 0; index < invocation.args.length; index++) {
      const token = invocation.args[index] ?? ""
      if (token === "--status" || token === "-s") {
        status = invocation.args[++index]
        continue
      }
      if (token.startsWith("--status=")) {
        status = token.slice("--status=".length)
        continue
      }
      if (token.startsWith("-")) break
      named.push(...beadIdCandidates(token))
    }
    if (status !== undefined && status.toLowerCase() !== "in_progress") for (const id of named) ids.add(id)
  }
  return [...ids]
}

/**
 * The leases after one command: claims that came or went since `before`, minus leases the
 * command ended. A claim whose actor or store is unknown cannot be renewed.
 */
export function nextLeases(current: Leases, before: ClaimState, after: ClaimState, ended: readonly string[]): Leases {
  const next: Leases = {}
  for (const [key, lease] of Object.entries(current)) if (after.claims[key] !== undefined) next[key] = lease
  for (const [key, claim] of Object.entries(after.claims)) {
    if (before.claims[key] !== undefined || claim.actor === null || claim.store === null) continue
    next[key] = { id: claim.id, actor: claim.actor, store: claim.store }
  }
  for (const [key, lease] of Object.entries(next)) if (ended.includes(lease.id)) delete next[key]
  return next
}

/** Why a heartbeat result means the lease is no longer held, or `undefined` when it renewed. */
export function heartbeatFailure(result: { output: string } | { failure: string }): string | undefined {
  if (!("output" in result)) return result.failure
  const text = result.output.trim()
  if (text === "") return undefined
  const parsed = parseTrailingJson(text)
  if (parsed === undefined) return "bd heartbeat returned invalid JSON"
  const error = (parsed as { error?: unknown } | null)?.error
  if (error !== undefined && error !== null && String(error).trim() !== "") return `bd heartbeat returned an error: ${String(error)}`
  return undefined
}

/** Run one `bd heartbeat` for `lease`, under the embedded write lock like every plugin write. */
export function heartbeatOnce(lease: Lease, run: BdRun, base: NodeJS.ProcessEnv): Promise<string | undefined> {
  const env = claimEnvironment(lease, base)
  return run(dirname(lease.store), ["heartbeat", lease.id, "--json"], Date.now() + HEARTBEAT_TIMEOUT_MS, env).then(
    heartbeatFailure,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

export type HeartbeatClock = {
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (timer: unknown) => void
}

export const realClock: HeartbeatClock = {
  setInterval: (callback, ms) => {
    const timer = setInterval(callback, ms)
    timer.unref?.()
    return timer
  },
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
}

type Timer = { owner: object; timer: unknown; clock: HeartbeatClock; running: boolean }

const REGISTRY: unique symbol = Symbol.for("srobroek.beads.heartbeats") as never

function timers(): Map<string, Timer> {
  const holder = globalThis as { [REGISTRY]?: Map<string, Timer> }
  holder[REGISTRY] ??= new Map()
  return holder[REGISTRY]
}

const timerKey = (sessionID: string, key: string) => `${sessionID}\0${key}`

/** The renewal timers one plugin instance owns. */
export class Heartbeats {
  readonly #owner = {}
  readonly #clock: HeartbeatClock
  readonly #beat: (sessionID: string, key: string, lease: Lease) => Promise<void>

  constructor(beat: (sessionID: string, key: string, lease: Lease) => Promise<void>, clock: HeartbeatClock = realClock) {
    this.#beat = beat
    this.#clock = clock
  }

  /** Run `sessionID`'s timers for exactly `leases`; `now` also renews each one once. */
  run(sessionID: string, leases: Leases, now = false): void {
    const prefix = `${sessionID}\0`
    for (const key of [...timers().keys()]) {
      if (key.startsWith(prefix) && leases[key.slice(prefix.length)] === undefined) this.#stop(key)
    }
    for (const [key, lease] of Object.entries(leases)) {
      const id = timerKey(sessionID, key)
      if (!timers().has(id)) {
        const entry: Timer = { owner: this.#owner, clock: this.#clock, running: false, timer: undefined }
        entry.timer = this.#clock.setInterval(() => void this.#tick(id, sessionID, key, lease), HEARTBEAT_INTERVAL_MS)
        timers().set(id, entry)
      }
      if (now) void this.#tick(id, sessionID, key, lease)
    }
  }

  /** Stop every timer of `sessionID`; the stored leases stay for the next execution. */
  pause(sessionID: string): void {
    const prefix = `${sessionID}\0`
    for (const key of [...timers().keys()]) if (key.startsWith(prefix)) this.#stop(key)
  }

  /** Whether a timer runs for this lease, in any instance. */
  active(sessionID: string, key: string): boolean {
    return timers().has(timerKey(sessionID, key))
  }

  /** Stop the timers this instance started. */
  dispose(): void {
    for (const [key, entry] of [...timers()]) if (entry.owner === this.#owner) this.#stop(key)
  }

  #stop(key: string): void {
    const entry = timers().get(key)
    if (entry === undefined) return
    timers().delete(key)
    try {
      entry.clock.clearInterval(entry.timer)
    } catch {
      // The host may already have cleared it.
    }
  }

  async #tick(id: string, sessionID: string, key: string, lease: Lease): Promise<void> {
    const entry = timers().get(id)
    if (entry === undefined || entry.running) return
    entry.running = true
    try {
      await this.#beat(sessionID, key, lease)
    } finally {
      entry.running = false
    }
  }
}
