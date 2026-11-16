import { describe, expect, test } from "bun:test"
import { contextFallback, contextNote } from "./fallback.ts"

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
