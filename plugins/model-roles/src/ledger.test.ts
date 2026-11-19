import { describe, expect, jest, test } from "bun:test"
import {
  createFirstTokenTracker,
  createLedgerStore,
  type LedgerStorage,
  newLedger,
  OUTCOME_KEY_PREFIX,
  type OutcomeRecord,
  onCompaction,
  onEnd,
  onExploration,
  onFailover,
  onResume,
  onSignals,
  onSpawn,
  onStep,
  prune,
} from "./ledger.ts"
import { summarizeUsage } from "./report.ts"

const DAY = 24 * 60 * 60 * 1000
const facts = { at: 1000, agent: "explore", model: "anthropic/haiku#low", parentID: "ses_p", tier: "cheap", source: "tier-param", rule: "tier-effort" } as const
const spawned = () => onSpawn(newLedger(), "ses_c", facts)

describe("reducers", () => {
  test("exploration facts are set once: a later call does not redraw the arm", () => {
    const first = { policy: "explore-v1", eligible: ["p/m#high", "p/m#low"], arm: "p/m#low", p: 0.05 }
    const set = onExploration(spawned(), "ses_c", first)
    expect(set.ses_c).toMatchObject(first)
    expect(onExploration(set, "ses_c", { ...first, arm: "p/m#high", p: 0.95 }).ses_c).toMatchObject({ arm: "p/m#low", p: 0.05 })
    expect(onExploration(newLedger(), "ses_none", first)).toEqual({})
  })

  test("a spawn starts a versioned record with the routing facts, no usage and unset experiment fields", () => {
    const record = spawned().ses_c
    expect(record).toEqual({
      ...facts,
      v: 2,
      resumes: 0,
      steps: 0,
      ms: 0,
    })
  })

  test("steps sum tokens, cache tokens, cost and count", () => {
    let ledger = spawned()
    ledger = onStep(ledger, "ses_c", { cost: 0.5, tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 40, write: 8 } } })
    ledger = onStep(ledger, "ses_c", { cost: 0.25, tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 60, write: 0 } } })
    expect(ledger.ses_c).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 8,
      cost: 0.75,
      steps: 2,
    })
  })

  test("a step with a time to first token records the first one reported; later steps and 0 do not overwrite it", () => {
    let ledger = onStep(spawned(), "ses_c", { firstTokenMs: 0 })
    expect(ledger.ses_c?.firstTokenMs).toBe(0)
    ledger = onStep(spawned(), "ses_c", {})
    expect(ledger.ses_c?.firstTokenMs).toBeUndefined()
    ledger = onStep(ledger, "ses_c", { firstTokenMs: 800 })
    ledger = onStep(ledger, "ses_c", { firstTokenMs: 200 })
    expect(ledger.ses_c?.firstTokenMs).toBe(800)
    expect(ledger.ses_c?.steps).toBe(3)
  })

  test("a step without a time to first token leaves it undefined, not 0", () => {
    const record = onStep(spawned(), "ses_c", { cost: 1 }).ses_c
    expect(record?.firstTokenMs).toBeUndefined()
    expect("firstTokenMs" in (record ?? {})).toBe(false)
  })

  test("the tracker measures first-token minus step start, once per step", () => {
    const t = createFirstTokenTracker()
    t.started("s", 1000)
    t.firstToken("s", 1450)
    expect(t.take("s")).toBe(450)
    expect(t.take("s")).toBeUndefined()
    t.started("s", 2000)
    expect(t.take("s")).toBeUndefined()
    t.firstToken("none", 5)
    expect(t.take("none")).toBeUndefined()
  })

  test("a compaction adds cost and tokens but is not a step; missing usage adds nothing", () => {
    let ledger = onStep(spawned(), "ses_c", { cost: 1, tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
    ledger = onCompaction(ledger, "ses_c", { cost: 0.5, tokens: { input: 90, output: 9, reasoning: 0, cache: { read: 3, write: 4 } } })
    ledger = onCompaction(ledger, "ses_c", {})
    expect(ledger.ses_c).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 1.5, steps: 1 })
  })

  test("usage stays absent until a step reports it; a reported 0 is kept; fields fill in independently", () => {
    let ledger = onStep(spawned(), "ses_c", {})
    expect(ledger.ses_c).toMatchObject({ steps: 1 })
    expect(Object.keys(ledger.ses_c ?? {})).not.toContain("cost")
    expect(Object.keys(ledger.ses_c ?? {})).not.toContain("inputTokens")
    ledger = onStep(ledger, "ses_c", { cost: 0, tokens: { input: 0 } })
    expect(ledger.ses_c).toMatchObject({ cost: 0, inputTokens: 0 })
    expect(Object.keys(ledger.ses_c ?? {})).not.toContain("outputTokens")
    ledger = onStep(ledger, "ses_c", { cost: 0.5, tokens: { output: 7, cache: { read: 3 } } })
    expect(ledger.ses_c).toMatchObject({ cost: 0.5, inputTokens: 0, outputTokens: 7, cacheReadTokens: 3 })
    expect(Object.keys(ledger.ses_c ?? {})).not.toContain("cacheWriteTokens")
    // A non-finite value is not a report.
    expect(Object.keys(onStep(spawned(), "ses_c", { cost: Number.NaN }).ses_c ?? {})).not.toContain("cost")
  })

  test("the first update of a legacy record drops its ambiguous zeros and stamps the version; a resume then reports cost 0", () => {
    const { v: _v, ...fresh } = spawned().ses_c as OutcomeRecord
    const legacy: OutcomeRecord = { ...fresh, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, steps: 1, outcome: "succeeded" }
    const resumed = onResume({ ses_c: legacy }, "ses_c")
    expect(resumed.ses_c?.v).toBe(2)
    for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cost"]) expect(Object.keys(resumed.ses_c ?? {})).not.toContain(key)
    const stepped = onEnd(onStep(resumed, "ses_c", { cost: 0, tokens: { input: 40 } }), "ses_c", "succeeded", 5000)
    const before = summarizeUsage([legacy], 2000).tiers[0]?.total
    expect(before).toMatchObject({ costRuns: 0, tokenRuns: 0 }) // legacy zeros are unknown
    const after = summarizeUsage([stepped.ses_c as OutcomeRecord], 2000).tiers[0]?.total
    expect(after).toMatchObject({ costRuns: 1, cost: 0, tokenRuns: 1, tokens: { total: { input: 40 } } })
    expect(after?.tokens?.total.output).toBeUndefined()
  })

  test("usage for a session that was never spawned is ignored", () => {
    const ledger = spawned()
    expect(onStep(ledger, "ses_other", { cost: 1 })).toBe(ledger)
    expect(onEnd(ledger, "ses_other", "succeeded", 5)).toBe(ledger)
  })

  test.each(["succeeded", "failed:credentials", "interrupted"] as const)("an end records the outcome %s and the elapsed time", (outcome) => {
    const ledger = onEnd(spawned(), "ses_c", outcome, 4500)
    expect(ledger.ses_c).toMatchObject({ outcome, ms: 3500 })
  })

  test("a resume counts on the same record and the time runs to the last end", () => {
    let ledger = onEnd(spawned(), "ses_c", "failed:quota", 2000)
    ledger = onResume(ledger, "ses_c")
    expect(ledger.ses_c?.outcome).toBeUndefined() // running again: the earlier outcome no longer stands
    expect(Object.keys(ledger.ses_c ?? {})).not.toContain("outcome")
    ledger = onSpawn(ledger, "ses_c", { ...facts, at: 9999 })
    ledger = onEnd(ledger, "ses_c", "succeeded", 7000)
    expect(Object.keys(ledger)).toEqual(["ses_c"])
    expect(ledger.ses_c).toMatchObject({ at: 1000, resumes: 1, outcome: "succeeded", ms: 6000 })
  })

  test("a failover is flagged", () => {
    expect(onFailover(spawned(), "ses_c").ses_c?.failedOver).toBe(true)
  })

  test("a record holds only numbers and short labels, no free text", () => {
    const ledger = onEnd(onStep(spawned(), "ses_c", { cost: 1, tokens: { input: 1 } }), "ses_c", "failed:auth", 2000)
    const record = ledger.ses_c as unknown as Record<string, unknown>
    const allowed = new Set(["v", "at", "agent", "tier", "model", "source", "rule", "parentID", "resumes", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "steps", "ms", "outcome", "failedOver"])
    for (const key of Object.keys(record)) expect(allowed.has(key)).toBe(true)
  })
})

describe("onSignals", () => {
  test("verdict and pass/fail replace the earlier value; none and false only fill gaps; true stays", () => {
    let ledger = onSignals(spawned(), "ses_c", { verdict: "approve", tests: "fail" })
    ledger = onSignals(ledger, "ses_c", { verdict: "request-changes", tests: "pass", touchedTests: true })
    ledger = onSignals(ledger, "ses_c", { tests: "none", touchedTests: false })
    expect(ledger.ses_c).toMatchObject({ verdict: "request-changes", tests: "pass", touchedTests: true })
  })

  test("none and false fill an unset record, and an unknown child is ignored", () => {
    expect(onSignals(spawned(), "ses_c", { tests: "none", touchedTests: false }).ses_c).toMatchObject({ tests: "none", touchedTests: false })
    const before = spawned()
    expect(onSignals(before, "other", { verdict: "comment" })).toBe(before)
  })
})

describe("prune", () => {
  const at = (id: string, when: number, ledger = newLedger()) => onSpawn(ledger, id, { ...facts, at: when })

  test("drops records older than the maximum age and keeps the boundary", () => {
    const now = 100 * DAY
    let ledger = at("old", now - 90 * DAY - 1)
    ledger = at("edge", now - 90 * DAY, ledger)
    ledger = at("new", now - DAY, ledger)
    expect(Object.keys(prune(ledger, now, { maxEntries: 1000, maxAgeMs: 90 * DAY })).sort()).toEqual(["edge", "new"])
  })

  test("keeps the newest records up to the entry limit", () => {
    let ledger = newLedger()
    for (let i = 0; i < 5; i++) ledger = at(`s${i}`, 1000 + i, ledger)
    expect(Object.keys(prune(ledger, 2000, { maxEntries: 3, maxAgeMs: DAY })).sort()).toEqual(["s2", "s3", "s4"])
  })

  test("defaults to 1000 entries and 90 days", () => {
    let ledger = newLedger()
    for (let i = 0; i < 1005; i++) ledger = at(`s${i}`, 1000 + i, ledger)
    expect(Object.keys(prune(ledger, 5000)).length).toBe(1000)
    expect(Object.keys(prune(ledger, 1000 + 91 * DAY)).length).toBe(0)
  })
})

describe("store", () => {
  const key = (id: string) => `${OUTCOME_KEY_PREFIX}${id}`
  const fake = (pageSize = 1000) => {
    const data = new Map<string, unknown>()
    const scans: Array<string | undefined> = []
    /** Holds a storage call until released: `setHolds` by the nth set call (1-based), `getHold` for every get. */
    const gate = {
      setHolds: new Map<number, Promise<void>>(),
      getHold: undefined as Promise<void> | undefined,
      sets: 0,
      /** Writes in the order they landed, as `<key> <outcome>`, and the most that ran at once on one key. */
      log: [] as string[],
      overlap: 0,
      /** Sets reject while true. */
      failSets: false,
      /** Sets never settle while true. */
      hangSets: false,
    }
    const running = new Map<string, number>()
    const storage: LedgerStorage = {
      get: async (k) => {
        // The value is read before the call blocks, as a real read in flight would.
        const snapshot = structuredClone(data.get(k))
        await gate.getHold
        return snapshot
      },
      set: async (k, value) => {
        const call = ++gate.sets
        if (gate.hangSets) return new Promise<void>(() => {})
        if (gate.failSets) throw new Error("storage down")
        const snapshot = structuredClone(value) as { resumes?: number; outcome?: string }
        running.set(k, (running.get(k) ?? 0) + 1)
        gate.overlap = Math.max(gate.overlap, running.get(k) ?? 0)
        try {
          await gate.setHolds.get(call)
          data.set(k, snapshot)
          gate.log.push(`${k} ${snapshot.outcome ?? "-"}`)
        } finally {
          running.set(k, (running.get(k) ?? 1) - 1)
        }
      },
      remove: async (k) => void data.delete(k),
      scan: async ({ prefix, after }) => {
        scans.push(after)
        const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort()
        const rest = after === undefined ? keys : keys.filter((k) => k > after)
        const page = rest.slice(0, pageSize)
        return { entries: page.map((k) => ({ key: k, value: data.get(k) })), ...(rest.length > page.length ? { next: page[page.length - 1] } : {}) }
      },
    }
    return { data, storage, scans, gate }
  }
  const hold = () => {
    let release: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test("writes on spawn and end at once, and debounces step writes into one", async () => {
    const { data, storage } = fake()
    const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000 })
    await store.spawn("ses_c", facts)
    expect(data.has(key("ses_c"))).toBe(true)
    await store.step("ses_c", { cost: 1 })
    await store.step("ses_c", { cost: 1 })
    expect((data.get(key("ses_c")) as { steps: number }).steps).toBe(0)
    await store.end("ses_c", "succeeded", 2000)
    expect(data.get(key("ses_c"))).toMatchObject({ steps: 2, cost: 2, outcome: "succeeded", ms: 1000 })
    await store.dispose()
  })

  test("dispose waits for a timer flush that is still writing, then the data is there", async () => {
    const { data, storage, gate } = fake()
    const store = createLedgerStore(storage, { debounceMs: 5, now: () => 2000 })
    await store.spawn("ses_c", facts) // set call 1
    const slow = hold()
    gate.setHolds.set(2, slow.promise)
    await store.step("ses_c", { cost: 3 })
    await pause(30) // the timer flush starts set call 2 and blocks in storage
    let disposed = false
    const disposing = store.dispose().then(() => {
      disposed = true
    })
    await pause(30)
    expect(disposed).toBe(false)
    slow.release()
    await disposing
    expect(data.get(key("ses_c"))).toMatchObject({ steps: 1, cost: 3 })
  })

  test("an older, slower write never lands over a later end state", async () => {
    const { data, storage, gate } = fake()
    const store = createLedgerStore(storage, { debounceMs: 5, now: () => 2000 })
    await store.spawn("ses_c", facts) // set call 1
    const slow = hold()
    gate.setHolds.set(2, slow.promise) // only the step flush's write is slow
    await store.step("ses_c", { cost: 1 })
    await pause(30)
    const ending = store.end("ses_c", "failed:auth", 2000) // set call 3 must wait for call 2
    await pause(30)
    slow.release()
    await ending
    await store.dispose()
    expect(data.get(key("ses_c"))).toMatchObject({ outcome: "failed:auth", steps: 1 })
  })

  test("two concurrent steps on a finished child both count", async () => {
    const { data, storage, gate } = fake()
    const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000 })
    await store.spawn("ses_c", facts)
    await store.end("ses_c", "succeeded", 1500)
    const slow = hold()
    gate.getHold = slow.promise
    const both = Promise.all([store.step("ses_c", { cost: 1, tokens: { input: 10 } }), store.step("ses_c", { cost: 2, tokens: { input: 20 } })])
    await pause(10)
    slow.release()
    await both
    await store.dispose()
    expect(data.get(key("ses_c"))).toMatchObject({ steps: 2, cost: 3, inputTokens: 30 })
  })

  test("a read still in flight when the record is pruned does not bring the key back", async () => {
    const { data, storage, gate } = fake()
    const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000, limits: { maxEntries: 2, maxAgeMs: 90 * DAY } })
    for (const [id, at] of [["old", 1000], ["mid", 1001]] as const) {
      await store.spawn(id, { ...facts, at })
      await store.end(id, "succeeded", 1500)
    }
    const slow = hold()
    gate.getHold = slow.promise
    const stepping = store.step("old", { cost: 1 })
    await pause(10)
    gate.getHold = undefined
    const spawning = store.spawn("new", { ...facts, at: 1002 }) // the third entry prunes "old"
    await pause(10)
    slow.release()
    await Promise.all([stepping, spawning])
    await store.dispose()
    expect(data.has(key("old"))).toBe(false)
    expect(store.size()).toBe(2)
  })

  test("nothing writes after dispose resolves, and later operations are refused", async () => {
    const { data, storage, gate } = fake()
    const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000 })
    await store.spawn("ses_c", facts)
    await store.end("ses_c", "succeeded", 1500)
    const slow = hold()
    gate.getHold = slow.promise
    const stepping = store.step("ses_c", { cost: 1 }) // a read in flight at shutdown
    await pause(10)
    const disposing = store.dispose()
    slow.release()
    await disposing
    await stepping
    const written = JSON.stringify([...data])
    const sets = gate.sets
    expect(JSON.parse(written)).toContainEqual([key("ses_c"), expect.objectContaining({ steps: 1 })])
    await store.step("ses_c", { cost: 5 })
    await store.end("ses_c", "interrupted", 9000)
    await store.spawn("ses_new", facts)
    await pause(30)
    expect(gate.sets).toBe(sets)
    expect(JSON.stringify([...data])).toBe(written)
  })

  test("a finished child leaves memory but a resumed run keeps adding to its stored record", async () => {
    const { data, storage } = fake()
    const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000 })
    await store.spawn("ses_c", facts)
    await store.end("ses_c", "failed:quota", 2000)
    expect(store.active()).toBe(0)
    await store.step("ses_c", { cost: 2, tokens: { input: 7 } })
    await store.resume("ses_c")
    await store.end("ses_c", "succeeded", 5000)
    expect(data.get(key("ses_c"))).toMatchObject({ resumes: 1, cost: 2, inputTokens: 7, steps: 1, outcome: "succeeded", ms: 4000 })
    await store.step("ses_unknown", { cost: 9 })
    expect(data.has(key("ses_unknown"))).toBe(false)
  })

  test("runtime retention caps entries, deleting the oldest from storage and memory", async () => {
    const { data, storage } = fake()
    const store = createLedgerStore(storage, { debounceMs: 10_000, limits: { maxEntries: 3, maxAgeMs: 90 * DAY }, now: () => 2000 })
    for (let i = 0; i < 5; i++) {
      await store.spawn(`s${i}`, { ...facts, at: 1000 + i })
      await store.end(`s${i}`, "succeeded", 1500)
    }
    expect(store.size()).toBe(3)
    expect([...data.keys()].sort()).toEqual([key("s2"), key("s3"), key("s4")])
    expect(store.active()).toBe(0)
  })

  test("load follows the scan cursor through every page, prunes stale records and skips malformed ones", async () => {
    const { data, storage, scans } = fake(2)
    const now = 200 * DAY
    const first = createLedgerStore(storage, { now: () => now })
    for (let i = 0; i < 5; i++) await first.spawn(`f${i}`, { ...facts, at: now - DAY })
    await first.spawn("stale", { ...facts, at: now - 91 * DAY })
    data.set(key("bad"), { at: "x" })
    scans.length = 0
    const store = createLedgerStore(storage, { now: () => now })
    await store.load()
    expect(scans.length).toBeGreaterThan(2)
    expect(store.size()).toBe(5)
    expect(data.has(key("stale"))).toBe(false)
    expect(data.has(key("f4"))).toBe(true)
    // A record from the last page is found again when its child resumes.
    await store.resume("f4")
    expect(data.get(key("f4"))).toMatchObject({ resumes: 1 })
  })

  describe("records", () => {
    test("follows the scan cursor through every page", async () => {
      const { storage, scans } = fake(2)
      const store = createLedgerStore(storage, { now: () => 2000 })
      for (let i = 0; i < 5; i++) await store.spawn(`s${i}`, { ...facts, at: 1000 + i })
      scans.length = 0
      const records = await store.records()
      expect(records.map((r) => r.at).sort()).toEqual([1000, 1001, 1002, 1003, 1004])
      expect(scans.length).toBeGreaterThan(2)
    })

    test("a record in memory overlays its older stored copy", async () => {
      const { data, storage } = fake()
      const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000 })
      await store.spawn("ses_c", facts)
      await store.step("ses_c", { cost: 2 }) // debounced: storage still has no cost
      expect(data.get(key("ses_c"))).not.toHaveProperty("cost")
      expect(await store.records()).toMatchObject([{ cost: 2, steps: 1 }])
      await store.dispose()
    })

    test("a storage error yields what is in memory and warns", async () => {
      const { storage } = fake()
      const warn = jest.fn()
      const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000, warn })
      await store.spawn("ses_c", facts)
      const failing: LedgerStorage = { ...storage, scan: async () => Promise.reject(new Error("scan down")) }
      const broken = createLedgerStore(failing, { debounceMs: 10_000, now: () => 2000, warn })
      await broken.spawn("ses_e", facts)
      expect(await broken.records()).toMatchObject([{ agent: "explore" }]) // the unwritten-or-running record in memory
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not read the records"), expect.anything())
      await store.dispose()
      await broken.dispose()
    })

    test("returns copies: changing a returned record leaves the ledger alone", async () => {
      const { storage } = fake()
      const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000 })
      await store.spawn("ses_c", facts)
      const [first] = await store.records()
      if (first === undefined) throw new Error("no record")
      first.agent = "changed"
      first.cost = 99
      expect(await store.records()).toMatchObject([{ agent: "explore" }])
      expect((await store.records())[0]?.cost).toBeUndefined()
      await store.dispose()
    })

    test("leaves out a stored record that retention no longer keeps, such as one whose removal failed", async () => {
      const { data, storage } = fake()
      const failingRemove: LedgerStorage = { ...storage, remove: async () => Promise.reject(new Error("remove down")) }
      const store = createLedgerStore(failingRemove, { debounceMs: 10_000, limits: { maxEntries: 2, maxAgeMs: 90 * DAY }, now: () => 2000 })
      for (let i = 0; i < 4; i++) {
        await store.spawn(`s${i}`, { ...facts, at: 1000 + i })
        await store.end(`s${i}`, "succeeded", 1500)
      }
      expect(store.size()).toBe(2)
      expect(data.has(key("s0"))).toBe(true) // still in storage
      expect((await store.records()).map((r) => r.at).sort()).toEqual([1002, 1003])
    })

    test("a resumed child is a record without an outcome until its run ends", async () => {
      const { storage } = fake()
      const store = createLedgerStore(storage, { debounceMs: 10_000, now: () => 2000 })
      await store.spawn("ses_c", facts)
      await store.end("ses_c", "succeeded", 2000)
      await store.resume("ses_c")
      expect((await store.records())[0]).toMatchObject({ resumes: 1 })
      expect((await store.records())[0]?.outcome).toBeUndefined()
      await store.end("ses_c", "failed:quota", 3000)
      expect((await store.records())[0]).toMatchObject({ outcome: "failed:quota" })
    })
  })

  describe("failures and bounds", () => {
    const warnings: string[] = []
    const make = (storage: LedgerStorage, extra: Record<string, unknown> = {}) =>
      createLedgerStore(storage, { debounceMs: 5, now: () => 2000, warn: (message: string, extra?: unknown) => void warnings.push(`${message} ${JSON.stringify(extra ?? {})}`), ...extra })

    test("a rejected end write keeps the record in memory, a resume continues from it, and dispose retries", async () => {
      const { data, storage, gate } = fake()
      const store = make(storage)
      await store.spawn("ses_c", facts)
      gate.failSets = true
      await store.step("ses_c", { cost: 2, tokens: { input: 5 } })
      await store.end("ses_c", "succeeded", 1500)
      expect(store.active()).toBe(1)
      expect((data.get(key("ses_c")) as { outcome?: string }).outcome).toBeUndefined()
      await store.resume("ses_c")
      gate.failSets = false
      await store.end("ses_c", "succeeded", 1800)
      expect(data.get(key("ses_c"))).toMatchObject({ cost: 2, inputTokens: 5, resumes: 1, outcome: "succeeded", ms: 800 })
      expect(store.active()).toBe(0)
      await store.dispose()
    })

    test("a record whose end write failed is written at dispose", async () => {
      const { data, storage, gate } = fake()
      const store = make(storage, { debounceMs: 10_000 })
      await store.spawn("ses_c", facts)
      gate.failSets = true
      await store.end("ses_c", "failed:auth", 1500)
      gate.failSets = false
      await store.dispose()
      expect(data.get(key("ses_c"))).toMatchObject({ outcome: "failed:auth" })
    })

    test("retries of a failing write are bounded and the give-up is logged", async () => {
      const { storage, gate } = fake()
      warnings.length = 0
      const store = make(storage, { maxWriteAttempts: 3 })
      await store.spawn("ses_c", facts)
      gate.failSets = true
      const before = gate.sets
      await store.end("ses_c", "succeeded", 1500)
      await pause(100)
      expect(gate.sets - before).toBe(3)
      expect(warnings.some((w) => w.includes("giving up"))).toBe(true)
      await store.dispose()
      expect(gate.sets - before).toBe(3)
    })

    test("dispose returns after its bound when storage never settles, and logs it", async () => {
      const { storage, gate } = fake()
      warnings.length = 0
      const store = make(storage, { disposeTimeoutMs: 40 })
      await store.spawn("ses_c", facts)
      gate.hangSets = true
      void store.end("ses_c", "succeeded", 1500)
      await pause(5)
      const started = Date.now()
      await store.dispose()
      expect(Date.now() - started).toBeLessThan(1000)
      expect(warnings.some((w) => w.includes("dispose"))).toBe(true)
    })

    /** Let queued promise work run; fake timers do not advance on their own. */
    const ticks = async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve()
    }
    /** Longer than the 5 s deadline the store once put on each storage call. */
    const PAST_OLD_DEADLINE_MS = 6000

    test("a write held past the old deadline cannot overwrite a later end state when it lands", async () => {
      jest.useFakeTimers()
      try {
        const { data, storage, gate } = fake()
        const store = make(storage, { debounceMs: 10_000 })
        await store.spawn("ses_c", facts) // set call 1
        const slow = hold()
        gate.setHolds.set(2, slow.promise)
        await store.step("ses_c", { cost: 1 })
        const flushing = store.flush() // set call 2 starts and stays held
        await ticks()
        const ending = store.end("ses_c", "succeeded", 1500)
        await ticks()
        jest.advanceTimersByTime(PAST_OLD_DEADLINE_MS)
        await ticks()
        // The end write waits behind the held one: nothing newer has landed yet.
        expect((data.get(key("ses_c")) as { outcome?: string }).outcome).toBeUndefined()
        slow.release()
        await Promise.all([flushing, ending])
        await ticks()
        expect(data.get(key("ses_c"))).toMatchObject({ outcome: "succeeded", steps: 1 })
        expect(gate.overlap).toBe(1)
        await store.dispose()
      } finally {
        jest.useRealTimers()
      }
    })

    test("a write held past the old deadline cannot bring back a pruned key when it lands", async () => {
      jest.useFakeTimers()
      try {
        const { data, storage, gate } = fake()
        const store = make(storage, { debounceMs: 10_000, limits: { maxEntries: 1, maxAgeMs: 90 * DAY } })
        const slow = hold()
        gate.setHolds.set(1, slow.promise)
        const first = store.spawn("old", { ...facts, at: 1000 }) // set call 1 stays held
        await ticks()
        const second = store.spawn("new", { ...facts, at: 1001 }) // the second entry prunes "old"
        await ticks()
        jest.advanceTimersByTime(PAST_OLD_DEADLINE_MS)
        await ticks()
        slow.release()
        await Promise.all([first, second])
        await ticks()
        expect(data.has(key("old"))).toBe(false)
        expect(data.has(key("new"))).toBe(true)
        await store.dispose()
      } finally {
        jest.useRealTimers()
      }
    })

    test("dispose lets an admitted end land first, then retries a failed record, with no overlap", async () => {
      const { data, storage, gate } = fake()
      const store = make(storage, { debounceMs: 10_000 })
      await store.spawn("failed", facts)
      await store.spawn("running", facts)
      gate.failSets = true
      await store.end("failed", "failed:auth", 1500) // the write fails; the record stays in memory
      gate.failSets = false
      gate.log.length = 0
      const slow = hold()
      gate.setHolds.set(gate.sets + 1, slow.promise)
      const ending = store.end("running", "succeeded", 1600) // admitted: its write is slow
      await pause(10)
      let disposed = false
      const disposing = store.dispose().then(() => {
        disposed = true
      })
      await pause(30)
      expect(disposed).toBe(false)
      slow.release()
      await Promise.all([ending, disposing])
      expect(gate.log).toEqual([`${key("running")} succeeded`, `${key("failed")} failed:auth`])
      expect(gate.overlap).toBe(1)
      expect(data.get(key("failed"))).toMatchObject({ outcome: "failed:auth" })
    })

    test("past the queue cap step updates coalesce without losing usage, and an end is never dropped", async () => {
      const { data, storage, gate } = fake()
      const store = make(storage, { debounceMs: 10_000, maxQueued: 3 })
      await store.spawn("ses_c", facts)
      await store.end("ses_c", "succeeded", 1500)
      const slow = hold()
      gate.getHold = slow.promise
      const steps = Array.from({ length: 12 }, () => store.step("ses_c", { cost: 1, tokens: { input: 10 } }))
      expect(store.queued("ses_c")).toBeLessThanOrEqual(3)
      const ending = store.end("ses_c", "failed:quota", 2500)
      expect(store.queued("ses_c")).toBeLessThanOrEqual(4)
      slow.release()
      await Promise.all([...steps, ending])
      await store.dispose()
      expect(data.get(key("ses_c"))).toMatchObject({ steps: 12, cost: 12, inputTokens: 120, outcome: "failed:quota" })
    })
  })
})
