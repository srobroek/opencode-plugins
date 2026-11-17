import { describe, expect, test } from "bun:test"
import { configRevision, hasOverflowed, readSnapshot, SNAPSHOT_MAX_AGE_MS, snapshotModel, staleSnapshots, unavailableReason } from "./snapshot.ts"

const snap = (at: number, extra: object = {}) => ({ model: "anthropic/claude-haiku", configRevision: "abc", at, ...extra })

describe("configRevision", () => {
  test("is the same for equal configs whatever their key order, and differs when a tier changes", () => {
    const a = { roles: { cheap: ["a/b#low"], strong: ["c/d"] }, tiers: { cheap: { effort: "low" } } } as never
    const b = { roles: { strong: ["c/d"], cheap: ["a/b#low"] }, tiers: { cheap: { effort: "low" } } } as never
    const c = { roles: { cheap: ["a/b#high"], strong: ["c/d"] }, tiers: { cheap: { effort: "low" } } } as never
    expect(configRevision(a)).toBe(configRevision(b))
    expect(configRevision(a)).not.toBe(configRevision(c))
  })
})

describe("readSnapshot", () => {
  test("keeps a valid snapshot and its optional fields; rejects malformed ones", () => {
    expect(readSnapshot(snap(5, { tier: "cheap", failedOver: true }))).toEqual(snap(5, { tier: "cheap", failedOver: true }))
    expect(readSnapshot(snap(5, { failedOver: false }))).toEqual(snap(5))
    expect(readSnapshot("cheap")).toBeUndefined()
    expect(readSnapshot({ ...snap(5), at: "x" })).toBeUndefined()
    expect(readSnapshot({ ...snap(5), model: "" })).toBeUndefined()
  })

  test("names the model with its variant", () => {
    expect(snapshotModel(snap(1, { model: "amazon-bedrock/claude-sonnet#high" }))).toEqual({ providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" })
  })

  test("keeps the models that overflowed, dropping junk entries", () => {
    expect(readSnapshot(snap(5, { overflowed: ["a/b#high", 3, "c/d"] }))?.overflowed).toEqual(["a/b#high", "c/d"])
    expect(readSnapshot(snap(5, { overflowed: [] }))).toEqual(snap(5))
    expect(readSnapshot(snap(5, { overflowed: "a/b" }))).toEqual(snap(5))
  })
})

describe("hasOverflowed", () => {
  const stored = readSnapshot(snap(5, { overflowed: ["amazon-bedrock/claude-sonnet#high"] }))
  test("matches the model whatever its variant", () => {
    expect(hasOverflowed(stored, { providerID: "amazon-bedrock", id: "claude-sonnet" })).toBe(true)
    expect(hasOverflowed(stored, { providerID: "amazon-bedrock", id: "claude-opus" })).toBe(false)
    expect(hasOverflowed(undefined, { providerID: "amazon-bedrock", id: "claude-sonnet" })).toBe(false)
  })
})

describe("unavailableReason", () => {
  const models = [{ providerID: "p", id: "m", variants: [{ id: "high" }] }, { providerID: "p", id: "off", enabled: false }]
  test("explains an unknown, disabled or variant-less model", () => {
    expect(unavailableReason({ providerID: "p", id: "m", variant: "high" }, models)).toBeUndefined()
    expect(unavailableReason({ providerID: "p", id: "x" }, models)).toBe("the model is unknown")
    expect(unavailableReason({ providerID: "p", id: "off" }, models)).toBe("the model is unavailable")
    expect(unavailableReason({ providerID: "p", id: "m", variant: "low" }, models)).toBe("the model has no variant 'low'")
  })
})

describe("staleSnapshots", () => {
  const now = 100 * SNAPSHOT_MAX_AGE_MS
  test("drops unreadable and expired entries", () => {
    const entries = [
      { key: "k:fresh", value: snap(now - 1000) },
      { key: "k:old", value: snap(now - SNAPSHOT_MAX_AGE_MS - 1) },
      { key: "k:junk", value: "x" },
    ]
    expect(staleSnapshots(entries, now).sort()).toEqual(["k:junk", "k:old"])
  })

  test("keeps the newest entries up to the limit", () => {
    const entries = [1, 2, 3, 4].map((n) => ({ key: `k:${n}`, value: snap(now - n * 1000) }))
    expect(staleSnapshots(entries, now, 2).sort()).toEqual(["k:3", "k:4"])
  })

  test("an open entry outlives the age window but not the limit", () => {
    const entries = [
      { key: "k:open", value: snap(now - SNAPSHOT_MAX_AGE_MS - 1) },
      { key: "k:ended", value: snap(now - SNAPSHOT_MAX_AGE_MS - 1) },
    ]
    expect(staleSnapshots(entries, now, 10, SNAPSHOT_MAX_AGE_MS, new Set(["k:open"]))).toEqual(["k:ended"])
    expect(staleSnapshots(entries, now, 0, SNAPSHOT_MAX_AGE_MS, new Set(["k:open"])).sort()).toEqual(["k:ended", "k:open"])
  })
})
