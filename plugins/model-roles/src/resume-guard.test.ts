import { describe, expect, test } from "bun:test"
import { resumeGuard, tierModels } from "./resume-guard.ts"

const opus = { providerID: "a", id: "opus" }
const sonnet = { providerID: "a", id: "sonnet", variant: "high" }
const haiku = { providerID: "b", id: "haiku" }

describe("resumeGuard", () => {
  test("keeps a model the guard accepts, and a child whose model is unknown", () => {
    expect(resumeGuard({ current: opus, refused: undefined, tier: "task", candidates: [{ model: sonnet, allowed: true }] })).toEqual({ action: "keep" })
    expect(resumeGuard({ current: undefined, refused: "x", tier: "task", candidates: [{ model: sonnet, allowed: true }] })).toEqual({ action: "keep" })
  })

  test("switches a refused model to the first candidate the guard accepts", () => {
    const candidates = [
      { model: opus, allowed: false },
      { model: sonnet, allowed: true },
      { model: haiku, allowed: true },
    ]
    expect(resumeGuard({ current: opus, refused: "too dear", tier: "task", candidates })).toEqual({ action: "switch", model: sonnet })
  })

  test("refuses with the model, the tier and the guard's reason when no candidate passes", () => {
    const decision = resumeGuard({ current: opus, refused: "too dear", tier: "task", candidates: [{ model: opus, allowed: false }] })
    expect(decision).toEqual({ action: "refuse", reason: "This resume would run on a/opus, which the guard refuses, and no candidate of tier 'task' passes the guard.\ntoo dear" })
  })

  test("refuses a child with no tier", () => {
    const decision = resumeGuard({ current: opus, refused: "too dear", tier: undefined, candidates: [] })
    expect(decision).toMatchObject({ action: "refuse" })
    expect((decision as { reason: string }).reason).toContain("no tier")
  })

  test("names the overflow when the only allowed candidates already overflowed", () => {
    const one = resumeGuard({ current: opus, refused: "too dear", tier: "task", candidates: [{ model: opus, allowed: false }], overflowed: [{ model: haiku, limit: 200_000 }] })
    expect(one).toEqual({
      action: "refuse",
      reason:
        "This resume would run on a/opus, which the guard refuses. The only allowed candidate, b/haiku (200000 tokens), already overflowed its context; compact the session or start a new one.\ntoo dear",
    })
    const two = resumeGuard({ current: opus, refused: "x", tier: "task", candidates: [], overflowed: [{ model: haiku, limit: 1_000 }, { model: sonnet }] })
    expect((two as { reason: string }).reason).toContain("The allowed candidates, b/haiku (1000 tokens), a/sonnet#high (unknown limit), already overflowed")
  })

  test("an allowed candidate that did not overflow still wins over the overflow note", () => {
    const decision = resumeGuard({ current: opus, refused: "x", tier: "task", candidates: [{ model: sonnet, allowed: true }], overflowed: [{ model: haiku }] })
    expect(decision).toEqual({ action: "switch", model: sonnet })
  })
})

describe("tierModels", () => {
  test("lists a tier's models in order, following links once and skipping cycles and unknown tiers", () => {
    const roles = { task: ["a/opus", "@other", "b/haiku"], other: ["a/sonnet#high", "@task", "@missing"] }
    expect(tierModels(roles, "task")).toEqual([opus, sonnet, haiku])
    expect(tierModels(roles, "nope")).toEqual([])
    expect(tierModels(roles, undefined)).toEqual([])
  })
})
