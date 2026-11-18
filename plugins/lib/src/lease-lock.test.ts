import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backoffDelayMs, type LeaseRecord, leaseAbandoned, withLease } from "./lease-lock.ts"

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "lease-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HOST = "this-host"
const record = (over: Partial<LeaseRecord> = {}): LeaseRecord => ({
  host: HOST,
  pid: process.pid,
  owner: "someone",
  token: "theirs",
  taken: Date.now(),
  expires: Date.now() + 60_000,
  ...over,
})
const plant = (path: string, value: LeaseRecord | string) =>
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
const tokenOf = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as LeaseRecord).token
const base = { owner: "test", host: HOST, leaseMs: 60_000, waitMs: 120 }

describe("leaseAbandoned", () => {
  const facts = { now: 1000, host: HOST, alive: () => true, leaseMs: 100, ageMs: 0 }
  const rows: Array<[string, LeaseRecord | undefined, Partial<typeof facts>, boolean]> = [
    ["a holder on this host whose pid is gone: abandoned at once", record({ expires: 9999 }), { alive: () => false }, true],
    ["a live holder with an unexpired lease", record({ expires: 9999 }), {}, false],
    ["a live holder whose lease nobody renewed", record({ expires: 500 }), {}, true],
    ["another host, unexpired: the pid says nothing about it", record({ host: "other", expires: 9999 }), { alive: () => false }, false],
    ["another host, expired", record({ host: "other", expires: 500 }), {}, true],
    ["an unparseable record older than one lease", undefined, { ageMs: 101 }, true],
    ["an unparseable record younger than one lease", undefined, { ageMs: 50 }, false],
  ]
  for (const [name, rec, over, expected] of rows) {
    test(name, () => expect(leaseAbandoned(rec, { ...facts, ...over })).toBe(expected))
  }
})

test("backoff is jittered between half and the full delay, and capped", () => {
  expect(backoffDelayMs(0, () => 0)).toBe(10)
  expect(backoffDelayMs(0, () => 0.999)).toBe(20)
  expect(backoffDelayMs(30, () => 0.999)).toBe(400)
})

describe("withLease", () => {
  test("runs the work under the lock and removes it afterwards", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    let during = ""
    const out = await withLease(lock, base, () => {
      during = tokenOf(lock)
      return 7
    })
    expect(out).toEqual({ kind: "done", value: 7 })
    expect(during).not.toBe("")
    expect(() => readFileSync(lock)).toThrow()
  })

  test("releases when the work throws", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    await expect(
      withLease(lock, base, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect((await withLease(lock, base, () => 1)).kind).toBe("done")
  })

  test("a second holder waits for the first", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    const order: string[] = []
    const first = withLease(lock, { ...base, waitMs: 2000 }, async () => {
      order.push("a-in")
      await new Promise((done) => setTimeout(done, 60))
      order.push("a-out")
    })
    await new Promise((done) => setTimeout(done, 10))
    const second = withLease(lock, { ...base, waitMs: 2000 }, () => {
      order.push("b-in")
    })
    await Promise.all([first, second])
    expect(order).toEqual(["a-in", "a-out", "b-in"])
  })

  test("a live, unexpired hold is kept: the waiter gives up busy and the hold is untouched", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, record())
    const out = await withLease(lock, base, () => 1)
    expect(out).toMatchObject({ kind: "failed", busy: true })
    expect(tokenOf(lock)).toBe("theirs")
  })

  test("a holder on this host whose pid is gone is taken over at once", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, record({ pid: 999_999, token: "dead" }))
    const out = await withLease(lock, { ...base, alive: () => false }, () => tokenOf(lock))
    expect(out.kind).toBe("done")
    expect(out.kind === "done" && out.value).not.toBe("dead")
  })

  test("an expired lease is taken over even though the holder's pid is alive", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, record({ host: "other", expires: Date.now() - 1000 }))
    expect((await withLease(lock, base, () => 1)).kind).toBe("done")
  })

  test("an unparseable record is judged by its age", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    plant(lock, "{not json")
    expect((await withLease(lock, { ...base, leaseMs: 60_000 }, () => 1)).kind).toBe("failed")
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    expect((await withLease(lock, { ...base, leaseMs: 60_000 }, () => 1)).kind).toBe("done")
  })

  test("a path that is not a regular file is never judged or taken over", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    mkdirSync(lock)
    const out = await withLease(lock, base, () => 1)
    expect(out).toMatchObject({ kind: "failed" })
  })

  test("the heartbeat renews the lease, so a long hold is not taken over while its holder works", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    const holder = withLease(lock, { ...base, leaseMs: 80, renewMs: 15, waitMs: 1000 }, async () => {
      await new Promise((done) => setTimeout(done, 400))
    })
    await new Promise((done) => setTimeout(done, 100))
    // Several leases old by now, but renewed: a contender with its own short patience must fail busy.
    const contender = await withLease(lock, { ...base, leaseMs: 80, waitMs: 200 }, () => "stolen")
    await holder
    expect(contender).toMatchObject({ kind: "failed", busy: true })
  })

  test("an owner whose lease lapsed cannot unlink or overwrite its successor", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    let successorToken = ""
    let seenAfterRelease = ""
    const stalled = withLease(lock, { ...base, leaseMs: 40, renewMs: 60_000, waitMs: 1000 }, async () => {
      // No renewals: the lease lapses while this owner is stalled.
      await new Promise((done) => setTimeout(done, 200))
    })
    await new Promise((done) => setTimeout(done, 20))
    const successor = withLease(lock, { ...base, leaseMs: 60_000, waitMs: 1000 }, async () => {
      successorToken = tokenOf(lock)
      await new Promise((done) => setTimeout(done, 300))
      seenAfterRelease = tokenOf(lock)
    })
    await Promise.all([stalled, successor])
    expect(successorToken).not.toBe("")
    // The stalled owner released in the middle of the successor's hold, found a token that is not its
    // own, and left the file alone.
    expect(seenAfterRelease).toBe(successorToken)
  })

  test("re-entrant along one call chain: the inner call does not wait on the outer", async () => {
    const dir = scratch()
    const lock = join(dir, "a.lock")
    const out = await withLease(lock, base, async () => (await withLease(lock, { ...base, waitMs: 20 }, () => "inner")).kind)
    expect(out).toEqual({ kind: "done", value: "done" })
  })

  describe("forced interleavings", () => {
    test("a waiter that judged a hold abandoned cannot unlink the fresh hold a faster one created", async () => {
      const dir = scratch()
      const lock = join(dir, "a.lock")
      plant(lock, record({ host: "other", expires: Date.now() - 1000, token: "old" }))
      const out = await withLease(lock, {
        ...base,
        waitMs: 60,
        seams: {
          // Between B judging the old hold abandoned and B opening the steal lock, A completes its own
          // takeover and holds a fresh lease (planted synchronously, as A's takeover would leave it).
          afterJudged: () => {
            writeFileSync(lock, JSON.stringify(record({ token: "fresh-from-A" })))
          },
        },
      }, () => "B ran")
      expect(out).toMatchObject({ kind: "failed", busy: true })
      expect(tokenOf(lock)).toBe("fresh-from-A")
    })

    test("steal-lock contention during a takeover: a live steal lock is neither cleared nor bypassed", async () => {
      const dir = scratch()
      const lock = join(dir, "a.lock")
      const steal = `${lock}.steal`
      plant(lock, record({ host: "other", expires: Date.now() - 1000, token: "stale" }))
      plant(steal, record({ token: "someone-mid-takeover" }))
      const out = await withLease(lock, base, () => "ran")
      expect(out).toMatchObject({ kind: "failed", busy: true })
      expect(tokenOf(steal)).toBe("someone-mid-takeover")
      expect(tokenOf(lock)).toBe("stale")
    })

    test("a steal lock whose holder crashed is cleared like any abandoned hold, and the takeover then goes through", async () => {
      const dir = scratch()
      const lock = join(dir, "a.lock")
      const steal = `${lock}.steal`
      plant(lock, record({ host: "other", expires: Date.now() - 1000, token: "stale" }))
      plant(steal, record({ pid: 999_999, token: "crashed-stealer" }))
      const out = await withLease(lock, { ...base, waitMs: 500, alive: (pid) => pid !== 999_999 }, () => "ran")
      expect(out).toEqual({ kind: "done", value: "ran" })
    })
  })
})
