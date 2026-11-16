import { describe, expect, test } from "bun:test"
import { type Arm, arms, chooseArm, type ExploreSpawn, eligible, exploreFacts, exploring, isReviewerAgent, parseExplore } from "./explore.ts"
import type { ModelRef } from "./resolve.ts"

const sonnet = (variant?: string): ModelRef => ({ providerID: "anthropic", id: "sonnet-5.5", ...(variant === undefined ? {} : { variant }) })
const sol = (variant?: string): ModelRef => ({ providerID: "openai", id: "gpt-6.1-sol", ...(variant === undefined ? {} : { variant }) })
const variants: Record<string, string[]> = {
  "anthropic/sonnet-5.5": ["low", "medium", "high", "xhigh", "max"],
  "openai/gpt-6.1-sol": ["low", "medium", "high"],
}
const filters = { variantsOf: (m: ModelRef) => variants[`${m.providerID}/${m.id}`] ?? [], allowed: () => true }
const labels = (list: Arm[]) => list.map((a) => a.label)

describe("arms", () => {
  test("a coding tier gives the control, one step up, one step down and the next candidate", () => {
    expect(labels(arms([sonnet("high"), sol("medium")], sonnet("high"), filters))).toEqual([
      "anthropic/sonnet-5.5#high",
      "anthropic/sonnet-5.5#xhigh",
      "anthropic/sonnet-5.5#medium",
      "openai/gpt-6.1-sol#medium",
    ])
  })

  test("the model at its top effort has no step up", () => {
    expect(labels(arms([sonnet("max"), sol("medium")], sonnet("max"), filters))).toEqual([
      "anthropic/sonnet-5.5#max",
      "anthropic/sonnet-5.5#xhigh",
      "openai/gpt-6.1-sol#medium",
    ])
  })

  test("steps skip a variant the model lacks, and a control without a variant has none", () => {
    const sparse = { ...filters, variantsOf: () => ["low", "high", "max"] }
    expect(labels(arms([], sonnet("high"), sparse))).toEqual(["anthropic/sonnet-5.5#high", "anthropic/sonnet-5.5#max", "anthropic/sonnet-5.5#low"])
    expect(labels(arms([sol("low")], sonnet(), filters))).toEqual(["anthropic/sonnet-5.5", "openai/gpt-6.1-sol#low"])
  })

  test("maxArms 1 keeps only the step up; 6 reaches the further candidates in order", () => {
    const tier = [sonnet("high"), sol("medium"), { providerID: "g", id: "a" }, { providerID: "g", id: "b" }, { providerID: "g", id: "c" }, { providerID: "g", id: "d" }]
    expect(labels(arms(tier, sonnet("high"), filters, 1))).toEqual(["anthropic/sonnet-5.5#high", "anthropic/sonnet-5.5#xhigh"])
    expect(labels(arms(tier, sonnet("high"), filters, 6))).toEqual([
      "anthropic/sonnet-5.5#high",
      "anthropic/sonnet-5.5#xhigh",
      "anthropic/sonnet-5.5#medium",
      "openai/gpt-6.1-sol#medium",
      "g/a",
      "g/b",
      "g/c",
    ])
  })

  test("a filtered arm stays empty: a later candidate does not take its place", () => {
    const noSol = { ...filters, allowed: (m: ModelRef) => m.providerID !== "openai" }
    expect(labels(arms([sonnet("high"), sol("medium"), { providerID: "g", id: "a" }], sonnet("high"), noSol))).toEqual([
      "anthropic/sonnet-5.5#high",
      "anthropic/sonnet-5.5#xhigh",
      "anthropic/sonnet-5.5#medium",
    ])
  })

  test("the guard filter never removes the control", () => {
    expect(labels(arms([sol("low")], sonnet("high"), { ...filters, allowed: () => false }))).toEqual(["anthropic/sonnet-5.5#high"])
  })
})

describe("chooseArm", () => {
  const all = arms([sonnet("high"), sol("medium")], sonnet("high"), filters)

  test.each([
    { draw: 0.05, label: "anthropic/sonnet-5.5#high", p: 0.95 },
    { draw: 0.99, label: "anthropic/sonnet-5.5#high", p: 0.95 },
    { draw: 0, label: "anthropic/sonnet-5.5#xhigh", p: 0.05 / 3 },
    { draw: 0.0166, label: "anthropic/sonnet-5.5#xhigh", p: 0.05 / 3 },
    { draw: 0.02, label: "anthropic/sonnet-5.5#medium", p: 0.05 / 3 },
    { draw: 0.0499, label: "openai/gpt-6.1-sol#medium", p: 0.05 / 3 },
  ])("a draw of $draw picks $label", ({ draw, label, p }) => {
    const chosen = chooseArm(all, 0.05, () => draw)
    expect(chosen.arm.label).toBe(label)
    expect(chosen.p).toBeCloseTo(p, 10)
  })

  test("uniform over the alternatives across a sweep of draws", () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 3000; i++) {
      const { arm } = chooseArm(all, 0.1, () => i / 3000)
      counts.set(arm.label, (counts.get(arm.label) ?? 0) + 1)
    }
    expect([...counts.values()].sort((a, b) => a - b)).toEqual([100, 100, 100, 2700])
  })

  test("a single arm is the control with p 1", () => {
    expect(chooseArm(all.slice(0, 1), 0.05, () => 0)).toEqual({ arm: all[0] as Arm, p: 1 })
  })
})

describe("eligible", () => {
  const base: ExploreSpawn = { agent: "explore", explicitModel: false, pinned: false, resume: false, effortAuto: false, distinctVendorTier: false, armCount: 3 }
  const on = { agents: ["explore", "code-reviewer", "adversarial-challenger"] }

  test("a plain spawn of a listed agent is eligible", () => {
    expect(eligible(base, on)).toBe(true)
  })

  test.each([
    ["an explicit model", { explicitModel: true }],
    ["a pin", { pinned: true }],
    ["a resume", { resume: true }],
    ["effort auto", { effortAuto: true }],
    ["an agent not listed", { agent: "build" }],
    ["a distinctVendor tier", { distinctVendorTier: true }],
    ["a *-reviewer agent", { agent: "code-reviewer" }],
    ["the adversarial-challenger", { agent: "adversarial-challenger" }],
    ["a single arm", { armCount: 1 }],
  ] as const)("%s is not", (_name, change) => {
    expect(eligible({ ...base, ...change }, on)).toBe(false)
  })

  test("reviewer names", () => {
    expect([isReviewerAgent("pr-reviewer"), isReviewerAgent("reviewer-notes"), isReviewerAgent("adversarial-challenger")]).toEqual([true, false, true])
  })
})

describe("parseExplore", () => {
  test("defaults leave exploration off", () => {
    const { options, warnings } = parseExplore(undefined)
    expect(options).toEqual({ agents: [], explore: 0.05, maxArms: 3, minN: 30, margin: 0.05, costTolerance: 0 })
    expect(warnings).toEqual([])
    expect(exploring(options)).toBe(false)
  })

  test("is on for agents and an explore above 0 only", () => {
    expect(exploring(parseExplore({ agents: ["explore"] }).options)).toBe(true)
    expect(exploring(parseExplore({ agents: ["explore"], explore: 0 }).options)).toBe(false)
  })

  test.each([
    [{ explore: 0.5 }, "explore", 0.1],
    [{ maxArms: 99 }, "maxArms", 6],
    [{ explore: "x" }, "explore", 0.05],
    [{ maxArms: 0 }, "maxArms", 3],
    [{ maxArms: 2.5 }, "maxArms", 3],
    [{ minN: 0 }, "minN", 30],
    [{ margin: 1 }, "margin", 0.05],
    [{ costTolerance: -1 }, "costTolerance", 0],
  ] as const)("%j warns and settles on a valid %s", (raw, key, value) => {
    const { options, warnings } = parseExplore(raw)
    expect(options[key]).toBe(value)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`evaluate.${key}`)
  })

  test("a bad agents list warns and stays off", () => {
    const { options, warnings } = parseExplore({ agents: "explore" })
    expect(options.agents).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test("accepts values in range", () => {
    expect(parseExplore({ agents: ["a"], explore: 0.1, maxArms: 6, minN: 50, margin: 0.1, costTolerance: 0.2 })).toEqual({
      options: { agents: ["a"], explore: 0.1, maxArms: 6, minN: 50, margin: 0.1, costTolerance: 0.2 },
      warnings: [],
    })
  })
})

test("exploreFacts lists the arms and the chosen one", () => {
  const all = arms([sonnet("high")], sonnet("high"), filters, 1)
  expect(exploreFacts(all, { arm: all[1] as Arm, p: 0.05 })).toEqual({
    policy: "explore-v1",
    eligible: ["anthropic/sonnet-5.5#high", "anthropic/sonnet-5.5#xhigh"],
    arm: "anthropic/sonnet-5.5#xhigh",
    p: 0.05,
  })
})
