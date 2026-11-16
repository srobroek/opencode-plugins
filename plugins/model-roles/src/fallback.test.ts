import { describe, expect, test } from "bun:test"
import { contextFallback, contextNote, contextSwitchNote } from "./fallback.ts"

const a = { providerID: "p", id: "a" }
const b = { providerID: "p", id: "b" }
const c = { providerID: "q", id: "c" }

describe("contextFallback", () => {
  const limits = (entries: Record<string, number>) => new Map(Object.entries(entries))

  test("picks the first candidate with a larger window", () => {
    expect(contextFallback([a, b, c], a, limits({ "p/a": 200_000, "p/b": 200_000, "q/c": 1_000_000 }))).toEqual(c)
    expect(contextFallback([b, c], a, limits({ "p/a": 100_000, "p/b": 200_000, "q/c": 1_000_000 }))).toEqual(b)
  })

  test("none when no candidate is larger", () => {
    expect(contextFallback([a, b], a, limits({ "p/a": 200_000, "p/b": 100_000 }))).toBeUndefined()
  })

  test("an equal window is not larger", () => {
    expect(contextFallback([a, b], a, limits({ "p/a": 200_000, "p/b": 200_000 }))).toBeUndefined()
  })

  test("unknown limits are not larger, on either side", () => {
    expect(contextFallback([a, b], a, limits({ "p/a": 200_000 }))).toBeUndefined()
    expect(contextFallback([a, b], a, limits({ "p/b": 200_000 }))).toBeUndefined()
  })

  test("the failed model is never its own fallback", () => {
    expect(contextFallback([a], a, limits({ "p/a": 200_000 }))).toBeUndefined()
  })
})

describe("contextNote", () => {
  test("names the model, its limit and the tier", () => {
    expect(contextNote(a, 200_000, "strong")).toBe(
      "context too long for p/a (200000 tokens); no larger-context candidate in tier strong. Compact the session or use a tier with a larger-context model",
    )
  })

  test("an unknown limit and tier are said so", () => {
    expect(contextNote(a, undefined, undefined)).toContain("p/a (unknown limit); no larger-context candidate in its tier.")
  })
})

describe("contextSwitchNote", () => {
  test("a switched child says where it now runs and how to resume it", () => {
    expect(contextSwitchNote({ failed: a, limit: 200_000, target: c, targetLimit: 1_000_000, tier: "strong", resumable: "ses_c" })).toBe(
      "context too long for p/a (200000 tokens); the session now runs q/c (1000000 tokens). Resume it with sessionID ses_c to continue on the larger context.",
    )
  })

  test("a session that was not switched names the larger candidate", () => {
    expect(contextSwitchNote({ failed: a, limit: 200_000, target: c, targetLimit: 1_000_000, tier: "strong" })).toBe(
      "context too long for p/a (200000 tokens); tier strong has a larger-context candidate, q/c (1000000 tokens). Switch to it or compact the session.",
    )
  })
})
