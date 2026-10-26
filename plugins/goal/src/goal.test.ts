import { describe, expect, test } from "bun:test"

import {
  activityDigest,
  activityFingerprint,
  addUsage,
  assessContinuationTurn,
  completeGoal,
  continuationDecision,
  createGoal,
  goalAfterRestart,
  goalFromJson,
  goalToolText,
  parseBudget,
  parseGoalCommand,
  pauseGoal,
  renderActivePrompt,
  renderContinuationPrompt,
  resumeGoal,
  setBudget,
  stepTokens,
} from "./goal.ts"

const goal = () => createGoal("ship it", 1000, "g1")

describe("parseGoalCommand", () => {
  test("subcommands", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "show" })
    expect(parseGoalCommand("show")).toEqual({ kind: "show" })
    expect(parseGoalCommand("PAUSE")).toEqual({ kind: "pause" })
    expect(parseGoalCommand("resume")).toEqual({ kind: "resume" })
    expect(parseGoalCommand("drop")).toEqual({ kind: "drop" })
    expect(parseGoalCommand("budget 200k")).toEqual({ kind: "budget", budget: { kind: "tokens", tokens: 200_000 } })
    expect(parseGoalCommand("set fix ci")).toEqual({ kind: "set", objective: "fix ci", replace: true })
  })

  test("anything else is the objective", () => {
    expect(parseGoalCommand("make the tests pass")).toEqual({
      kind: "set",
      objective: "make the tests pass",
      replace: false,
    })
    expect(parseGoalCommand("drop the legacy API")).toEqual({
      kind: "set",
      objective: "drop the legacy API",
      replace: false,
    })
  })

  test("errors", () => {
    expect(parseGoalCommand("budget")).toContain("Usage: /goal budget")
    expect(parseGoalCommand("set")).toBe("Usage: /goal set <objective>")
    expect(parseGoalCommand("budget lots")).toContain("Goal budget must be")
  })
})

describe("parseBudget", () => {
  test("tokens, dollars and off", () => {
    expect(parseBudget("50000")).toEqual({ kind: "tokens", tokens: 50_000 })
    expect(parseBudget("1.5m")).toEqual({ kind: "tokens", tokens: 1_500_000 })
    expect(parseBudget("200,000")).toEqual({ kind: "tokens", tokens: 200_000 })
    expect(parseBudget("$2.50")).toEqual({ kind: "cost", usd: 2.5 })
    expect(parseBudget("3usd")).toEqual({ kind: "cost", usd: 3 })
    expect(parseBudget("off")).toEqual({ kind: "off" })
    expect(parseBudget("0")).toContain("positive")
    expect(parseBudget("$0")).toContain("positive")
  })
})

describe("goal transitions", () => {
  test("pause and resume", () => {
    const paused = pauseGoal(goal(), "interrupted", 2000)
    expect(paused).toMatchObject({ status: "paused", pauseReason: "interrupted", updatedAt: 2000 })
    expect(pauseGoal(paused, "again", 3000)).toBe(paused)
    const resumed = resumeGoal(paused, 3000)
    expect(resumed).toMatchObject({ status: "active", updatedAt: 3000 })
    expect(resumed).not.toHaveProperty("pauseReason")
  })

  test("resume of a spent goal stays budget-limited", () => {
    const spent = { ...pauseGoal(goal(), "x", 1), tokenBudget: 10, tokensUsed: 10 }
    expect(resumeGoal(spent, 2)).toMatchObject({ status: "budget-limited" })
  })

  test("complete needs evidence and only happens once", () => {
    expect(completeGoal(goal(), "  ", 2)).toContain("needs evidence")
    const done = completeGoal(goal(), "bun test: 12 pass", 2)
    expect(done).toMatchObject({ status: "complete", evidence: "bun test: 12 pass" })
    if (typeof done === "string") throw new Error(done)
    expect(completeGoal(done, "again", 3)).toBe("Goal is already complete.")
    expect(resumeGoal(done, 3)).toBe("Goal is already complete.")
  })

  test("budgets flip status both ways", () => {
    const used = { ...goal(), tokensUsed: 100 }
    const limited = setBudget(used, { kind: "tokens", tokens: 50 }, 2)
    expect(limited.status).toBe("budget-limited")
    const raised = setBudget(limited, { kind: "tokens", tokens: 500 }, 3)
    expect(raised.status).toBe("active")
    const off = setBudget({ ...raised, costBudget: 1 }, { kind: "off" }, 4)
    expect(off).not.toHaveProperty("tokenBudget")
    expect(off).not.toHaveProperty("costBudget")
  })

  test("usage accumulates and reports the crossing once", () => {
    const budgeted = setBudget(goal(), { kind: "cost", usd: 0.1 }, 1)
    const first = addUsage(budgeted, { tokens: 100, cost: 0.06 }, 2)
    expect(first).toMatchObject({ limited: false, goal: { tokensUsed: 100, status: "active" } })
    const second = addUsage(first.goal, { tokens: 10, cost: 0.06 }, 3)
    expect(second).toMatchObject({ limited: true, goal: { status: "budget-limited" } })
    expect(addUsage(second.goal, { tokens: 1, cost: 0 }, 4).limited).toBe(false)
    const paused = pauseGoal(goal(), "x", 1)
    expect(addUsage(paused, { tokens: 5, cost: 0 }, 2).goal).toBe(paused)
  })

  test("stepTokens counts new input, output, reasoning and cache writes", () => {
    expect(stepTokens({ input: 10, output: 5, reasoning: 2, cache: { read: 1000, write: 3 } })).toBe(20)
    expect(stepTokens(undefined)).toBe(0)
  })

  test("restart pauses an active goal and leaves others alone", () => {
    expect(goalAfterRestart(goal(), 5)).toMatchObject({ status: "paused", pauseReason: "restarted" })
    const limited = { ...goal(), status: "budget-limited" as const }
    expect(goalAfterRestart(limited, 5)).toBe(limited)
  })

  test("goalFromJson rejects malformed records", () => {
    expect(goalFromJson(JSON.parse(JSON.stringify(goal())))).toEqual(goal())
    expect(goalFromJson({ id: "x" })).toBeUndefined()
    expect(goalFromJson({ ...goal(), status: "dropped" })).toBeUndefined()
    expect(goalFromJson(null)).toBeUndefined()
  })
})

describe("prompts", () => {
  test("objective text is escaped and budgets shown", () => {
    const g = { ...goal(), objective: "fix <b> & co", tokenBudget: 1000, tokensUsed: 400 }
    const text = renderContinuationPrompt(g)
    expect(text).toContain("fix &lt;b&gt; &amp; co")
    expect(text).toContain("Tokens remaining: 600")
    expect(text).toContain("goal_complete")
    expect(renderActivePrompt(g)).toContain("goal_get")
  })

  test("tool text", () => {
    expect(goalToolText(undefined)).toBe("No goal is set for this session.")
    expect(goalToolText(pauseGoal(goal(), "interrupted", 1))).toContain("/goal resume")
  })
})

describe("activity", () => {
  test("digests are stable across key order", () => {
    expect(activityDigest(["call", "read", { a: 1, b: 2 }])).toBe(activityDigest(["call", "read", { b: 2, a: 1 }]))
    expect(activityDigest(["call", "read", { a: 1 }])).not.toBe(activityDigest(["call", "read", { a: 2 }]))
  })

  test("assessment", () => {
    const fp = activityFingerprint([activityDigest(["call", "read", {}])])
    expect(assessContinuationTurn("", undefined)).toBe("no-activity")
    expect(assessContinuationTurn(fp, fp)).toBe("repeated")
    expect(assessContinuationTurn(fp, undefined)).toBe("progress")
  })
})

describe("continuationDecision", () => {
  const base = {
    goal: goal(),
    root: true,
    running: false,
    loopEnabled: false,
    agent: "build",
    runningChildren: 0,
    runningShells: 0,
    stalled: false,
    continuations: 0,
    maxContinuations: 25,
  }

  test("continues an idle active root goal", () => {
    expect(continuationDecision(base)).toEqual({ continue: true })
  })

  test("guards", () => {
    expect(continuationDecision({ ...base, goal: undefined })).toEqual({ continue: false, reason: "inactive" })
    expect(continuationDecision({ ...base, root: false })).toEqual({ continue: false, reason: "inactive" })
    expect(continuationDecision({ ...base, loopEnabled: true })).toEqual({ continue: false, reason: "inactive" })
    expect(continuationDecision({ ...base, goal: pauseGoal(goal(), "x", 1) })).toMatchObject({ reason: "inactive" })
    expect(continuationDecision({ ...base, running: true })).toMatchObject({ reason: "busy" })
    expect(continuationDecision({ ...base, agent: "plan" })).toMatchObject({ reason: "plan" })
    expect(continuationDecision({ ...base, stalled: true })).toMatchObject({ reason: "stalled" })
    expect(continuationDecision({ ...base, continuations: 25 })).toMatchObject({ reason: "cap" })
    expect(continuationDecision({ ...base, runningChildren: 1 })).toMatchObject({ reason: "deferred" })
    expect(continuationDecision({ ...base, runningShells: 1 })).toMatchObject({ reason: "deferred" })
  })
})
