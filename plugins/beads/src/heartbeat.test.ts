import { describe, expect, test } from "bun:test"
import { bdInvocations } from "./bd-actor-gate.ts"
import { readClaimState, recordClaimTransitions } from "./claims.ts"
import type { BdRun } from "./gate-admission.ts"
import {
  HEARTBEAT_INTERVAL_MS,
  type HeartbeatClock,
  Heartbeats,
  heartbeatFailure,
  heartbeatOnce,
  type Lease,
  leaseEndingIds,
  nextLeases,
  readLeases,
} from "./heartbeat.ts"

class FakeClock implements HeartbeatClock {
  #next = 0
  readonly callbacks = new Map<number, () => void>()
  setInterval(callback: () => void, ms: number): unknown {
    expect(ms).toBe(HEARTBEAT_INTERVAL_MS)
    const id = ++this.#next
    this.callbacks.set(id, callback)
    return id
  }
  clearInterval(timer: unknown): void {
    this.callbacks.delete(timer as number)
  }
  tick(): void {
    for (const callback of [...this.callbacks.values()]) callback()
  }
}

const lease = (id: string): Lease => ({ id, actor: "opencode/r/general/s", store: "/repo/.beads" })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function claims(commands: string[]) {
  const state = readClaimState(undefined)
  const env = { BEADS_DIR: "/repo/.beads", BD_ACTOR: "opencode/r/general/s" }
  for (const command of commands) recordClaimTransitions(state, command, "/repo", env, "ok", bdInvocations(command))
  return state
}

describe("which claims are renewed", () => {
  test("a new claim with actor and store gets a lease; a dropped claim loses it", () => {
    const empty = claims([])
    const claimed = claims(["bd update hb-1 --claim"])
    const leases = nextLeases({}, empty, claimed, [])
    expect(Object.values(leases)).toEqual([lease("hb-1")])
    const closed = claims(["bd update hb-1 --claim", "bd close hb-1 --reason done"])
    expect(nextLeases(leases, claimed, closed, [])).toEqual({})
  })

  test("a status other than in_progress ends the lease but keeps the claim", () => {
    const claimed = claims(["bd update hb-1 --claim"])
    const leases = nextLeases({}, claims([]), claimed, [])
    const parked = claims(["bd update hb-1 --claim", "bd update hb-1 --status blocked"])
    expect(Object.keys(parked.claims)).toHaveLength(1)
    expect(nextLeases(leases, claimed, parked, leaseEndingIds(bdInvocations("bd update hb-1 --status blocked")))).toEqual({})
  })

  test("leaseEndingIds reads both spellings and ignores in_progress", () => {
    expect(leaseEndingIds(bdInvocations("bd update hb-1 hb-2 -s open"))).toEqual(["hb-1", "hb-2"])
    expect(leaseEndingIds(bdInvocations("bd update hb-1 --status=deferred"))).toEqual(["hb-1"])
    expect(leaseEndingIds(bdInvocations("bd update hb-1 --status in_progress"))).toEqual([])
    expect(leaseEndingIds(bdInvocations("bd update hb-1 --claim"))).toEqual([])
    expect(leaseEndingIds(bdInvocations("bd show hb-1 --status open"))).toEqual([])
  })

  test("a claim whose actor is unknown is not renewed", () => {
    const state = readClaimState({ claims: { k: { id: "hb-1", actor: null, store: "/repo/.beads" } }, actors: [] })
    expect(nextLeases({}, readClaimState(undefined), state, [])).toEqual({})
  })

  test("readLeases drops malformed entries", () => {
    expect(readLeases({ a: lease("hb-1"), b: { id: "hb-2" }, c: null })).toEqual({ a: lease("hb-1") })
    expect(readLeases("nope")).toEqual({})
  })
})

describe("one heartbeat", () => {
  test("runs bd heartbeat with the claim's store and actor", async () => {
    const calls: Array<{ cwd: string; args: string[]; env: NodeJS.ProcessEnv; deadline: number }> = []
    const run: BdRun = async (cwd, args, deadline, env) => {
      calls.push({ cwd, args, env, deadline })
      return { output: JSON.stringify({ data: { id: "hb-1" }, schema_version: 1 }) }
    }
    expect(await heartbeatOnce(lease("hb-1"), run, {})).toBeUndefined()
    expect(calls[0]?.args).toEqual(["heartbeat", "hb-1", "--json"])
    expect(calls[0]?.cwd).toBe("/repo")
    expect(calls[0]?.env).toMatchObject({ BEADS_DIR: "/repo/.beads", BD_ACTOR: "opencode/r/general/s", BEADS_DOLT_SHARED_SERVER: "" })
    expect((calls[0]?.deadline ?? Infinity) - Date.now()).toBeLessThanOrEqual(10_000)
  })

  test("a failure, an error envelope or invalid JSON ends the lease", () => {
    expect(heartbeatFailure({ failure: "bd exited with code 1: not the owner" })).toBe("bd exited with code 1: not the owner")
    expect(heartbeatFailure({ output: '{"error":"lease expired"}' })).toBe("bd heartbeat returned an error: lease expired")
    expect(heartbeatFailure({ output: "not json" })).toBe("bd heartbeat returned invalid JSON")
    expect(heartbeatFailure({ output: "" })).toBeUndefined()
    expect(heartbeatFailure({ output: '{"error":null,"data":{}}' })).toBeUndefined()
  })

  test("a throwing runner is a failure, not an exception", async () => {
    const run: BdRun = async () => {
      throw new Error("spawn failed")
    }
    expect(await heartbeatOnce(lease("hb-1"), run, {})).toBe("spawn failed")
  })
})

describe("heartbeat timers", () => {
  test("renew every interval, pause, and resume with an immediate renewal", async () => {
    const clock = new FakeClock()
    const beats: string[] = []
    const heartbeats = new Heartbeats(async (sessionID, _key, l) => void beats.push(`${sessionID}:${l.id}`), clock)
    heartbeats.run("ses_hb1", { k: lease("hb-1") })
    expect(beats).toEqual([])
    clock.tick()
    await flush()
    expect(beats).toEqual(["ses_hb1:hb-1"])
    heartbeats.pause("ses_hb1")
    clock.tick()
    await flush()
    expect(beats).toHaveLength(1)
    heartbeats.run("ses_hb1", { k: lease("hb-1") }, true)
    await flush()
    expect(beats).toHaveLength(2)
    heartbeats.dispose()
    expect(clock.callbacks.size).toBe(0)
  })

  test("never overlaps a heartbeat for one lease, and starts one timer per lease", async () => {
    const clock = new FakeClock()
    let release: () => void = () => {}
    let started = 0
    const heartbeats = new Heartbeats(async () => {
      started++
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }, clock)
    heartbeats.run("ses_hb2", { k: lease("hb-1") })
    heartbeats.run("ses_hb2", { k: lease("hb-1") })
    expect(clock.callbacks.size).toBe(1)
    clock.tick()
    clock.tick()
    await flush()
    expect(started).toBe(1)
    release()
    await flush()
    clock.tick()
    await flush()
    expect(started).toBe(2)
    release()
    heartbeats.dispose()
  })

  test("a lease missing from the next run is stopped; other sessions are untouched", () => {
    const clock = new FakeClock()
    const heartbeats = new Heartbeats(async () => {}, clock)
    heartbeats.run("ses_hb3", { a: lease("hb-1"), b: lease("hb-2") })
    heartbeats.run("ses_hb4", { a: lease("hb-1") })
    heartbeats.run("ses_hb3", { b: lease("hb-2") })
    expect(heartbeats.active("ses_hb3", "a")).toBe(false)
    expect(heartbeats.active("ses_hb3", "b")).toBe(true)
    expect(heartbeats.active("ses_hb4", "a")).toBe(true)
    heartbeats.pause("ses_hb3")
    expect(heartbeats.active("ses_hb4", "a")).toBe(true)
    heartbeats.dispose()
    expect(heartbeats.active("ses_hb4", "a")).toBe(false)
  })

  test("two instances never run two timers for one lease; each disposes only its own", () => {
    const clock = new FakeClock()
    const one = new Heartbeats(async () => {}, clock)
    const two = new Heartbeats(async () => {}, clock)
    one.run("ses_hb5", { a: lease("hb-1") })
    two.run("ses_hb5", { a: lease("hb-1") })
    expect(clock.callbacks.size).toBe(1)
    two.dispose()
    expect(one.active("ses_hb5", "a")).toBe(true)
    one.dispose()
    expect(clock.callbacks.size).toBe(0)
  })
})
