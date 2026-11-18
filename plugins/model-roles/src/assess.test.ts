import { describe, expect, test } from "bun:test"
import { type ArmSample, type Assessment, assess, assessmentStats, assessmentText, type GroupStats, newcombe, reward } from "./assess.ts"
import type { OutcomeRecord } from "./ledger.ts"

/*
 * Expected interval bounds come from statsmodels 0.15.0,
 * `confint_proportions_2indep(c1, n1, c2, n2, method="newcomb", compare="diff", alpha=0.05)`,
 * which implements Newcombe (1998), "Interval estimation for the difference between independent
 * proportions", Statistics in Medicine 17:873-890, method 10. The first four rows are worked
 * examples from the paper.
 */

const POLICY = { minN: 30, margin: 0.05, costTolerance: 0 }

/** Unit weights: every run has p = 1, so the sums are plain counts. */
const sample = (arm: string, n: number, k: number, cps?: number): ArmSample => ({
  arm,
  n,
  sumW: n,
  sumW2: n,
  sumWR: k,
  costRuns: cps === undefined ? 0 : n,
  sumWCost: cps === undefined ? 0 : cps * k,
  sumWRCost: cps === undefined ? 0 : k,
})

const CONTROL = "p/m#medium"
const ARM = "p/m#high"
const group = (arms: ArmSample[], extra: Partial<GroupStats> = {}): GroupStats => ({ tier: "standard", agent: "coder", control: CONTROL, arms, unscored: 0, ...extra })

describe("newcombe", () => {
  test.each([
    [56, 70, 48, 80, 0.0524314724, 0.333872654],
    [9, 10, 3, 10, 0.1705227239, 0.8090179735],
    [10, 10, 0, 20, 0.6790860371, 1],
    [0, 10, 0, 20, -0.1611251581, 0.2775327999],
    [30, 30, 0, 30, 0.8394678199, 1],
  ])("%i/%i − %i/%i matches the reference bounds", (k1, n1, k2, n2, lower, upper) => {
    const ci = newcombe(k1 / n1, n1, k2 / n2, n2)
    expect(ci.lower).toBeCloseTo(lower, 8)
    expect(ci.upper).toBeCloseTo(upper, 8)
  })
})

describe("assess", () => {
  test.each([
    [29, 30, "keep"],
    [30, 29, "keep"],
    [30, 30, "recommend"],
  ])("arm n=%i, control n=%i with minN 30: %s", (armN, controlN, decision) => {
    const a = assess(group([sample(ARM, armN, armN, 0.5), sample(CONTROL, controlN, 15, 0.5)]), POLICY)
    expect(a.decision).toBe(decision as Assessment["decision"])
    if (a.decision === "keep") expect(a).toMatchObject({ reason: "runs", n: 29, minN: 30 })
  })

  test("the recommendation carries the Newcombe evidence: 30/30 vs 15/30", () => {
    const a = assess(group([sample(ARM, 30, 30, 0.5), sample(CONTROL, 30, 15, 0.5)]), POLICY)
    expect(a).toMatchObject({ decision: "recommend", arm: ARM, control: CONTROL })
    if (a.decision !== "recommend") return
    expect(a.evidence.diff).toBeCloseTo(0.5, 12)
    expect(a.evidence.lower).toBeCloseTo(0.2968654664, 8)
    expect(a.evidence.upper).toBeCloseTo(0.6684587436, 8)
  })

  // 24/30 vs 15/30: lower bound 0.058490039278 (reference above).
  test.each([
    [0.0584, "recommend"],
    [0.0585, "keep"],
  ])("lower bound 0.05849 against margin %d: %s", (margin, decision) => {
    const a = assess(group([sample(ARM, 30, 24, 0.5), sample(CONTROL, 30, 15, 0.5)]), { ...POLICY, margin })
    expect(a.decision).toBe(decision as Assessment["decision"])
    expect(a.decision === "keep" ? a.reason : undefined).toBe(decision === "keep" ? "interval" : undefined)
    expect((a as { evidence?: { lower: number } }).evidence?.lower).toBeCloseTo(0.0584900393, 8)
  })

  // Control $0.50 per success with tolerance 0.25 allows up to $0.625.
  test.each([
    [0.625, "recommend"],
    [0.626, "keep"],
  ])("arm cost/success %d against a $0.625 ceiling: %s", (cps, decision) => {
    const a = assess(group([sample(ARM, 30, 30, cps), sample(CONTROL, 30, 15, 0.5)]), { ...POLICY, costTolerance: 0.25 })
    expect(a.decision).toBe(decision as Assessment["decision"])
    if (a.decision === "keep") expect(a.reason).toBe("cost")
  })

  test.each([
    ["arm", sample(ARM, 30, 30), sample(CONTROL, 30, 15, 0.5)],
    ["control", sample(ARM, 30, 30, 0.5), sample(CONTROL, 30, 15)],
  ])("unknown %s cost fails the cost test", (_side, arm, control) => {
    expect(assess(group([arm, control]), POLICY)).toMatchObject({ decision: "keep", reason: "cost" })
  })

  // 0/30 vs 0/30 and 30/30 vs 30/30 both give (−0.1135133932, 0.1135133932).
  test.each([0, 30])("all rates %i/30 on both sides keep, the interval centred on 0", (k) => {
    const a = assess(group([sample(ARM, 30, k, 0.5), sample(CONTROL, 30, k, 0.5)]), POLICY)
    expect(a).toMatchObject({ decision: "keep", reason: "interval" })
    const e = a.decision === "keep" ? a.evidence : undefined
    expect(e?.lower).toBeCloseTo(-0.1135133932, 8)
    expect(e?.upper).toBeCloseTo(0.1135133932, 8)
  })

  describe("rollback", () => {
    // The adopted control is `#high`; the previous one, `#medium`, now beats it: 30/30 vs 15/30.
    const PREVIOUS = "p/m#medium"
    const ADOPTED = "p/m#high"
    const arms = [sample(PREVIOUS, 30, 30, 0.5), sample(ADOPTED, 30, 15, 0.5)]

    test("an adoption that made the control, beaten by the control it replaced, rolls back", () => {
      const a = assess(group(arms, { control: ADOPTED, adoption: { tier: "standard", from: PREVIOUS, to: ADOPTED, at: 1 } }), POLICY)
      expect(a).toMatchObject({ decision: "rollback", arm: PREVIOUS, control: ADOPTED })
    })

    test.each([
      ["no adoption history", undefined],
      ["an adoption that did not make the current control", { tier: "standard", from: PREVIOUS, to: "q/other", at: 1 }],
    ])("with %s the previous control is an ordinary arm", (_name, adoption) => {
      const a = assess(group(arms, { control: ADOPTED, ...(adoption === undefined ? {} : { adoption }) }), POLICY)
      expect(a).toMatchObject({ decision: "recommend", arm: PREVIOUS })
    })

    test("an adopted control the previous one does not beat is kept", () => {
      const a = assess(group([sample(PREVIOUS, 30, 15, 0.5), sample(ADOPTED, 30, 15, 0.5)], { control: ADOPTED, adoption: { tier: "standard", from: PREVIOUS, to: ADOPTED, at: 1 } }), POLICY)
      expect(a).toMatchObject({ decision: "keep", reason: "interval" })
    })
  })
})

describe("reward", () => {
  test.each([
    ["a failure", { outcome: "failed:other" as const, tests: "pass" as const }, undefined, 0],
    ["an interruption", { outcome: "interrupted" as const }, { outcome: "succeeded" as const, verdict: "approve" as const }, 0],
    ["failing tests", { outcome: "succeeded" as const, tests: "fail" as const }, undefined, 0],
    ["passing tests, no test edits", { outcome: "succeeded" as const, tests: "pass" as const }, undefined, 1],
    ["passing tests after editing tests, no reviewer", { outcome: "succeeded" as const, tests: "pass" as const, touchedTests: true }, undefined, undefined],
    ["passing tests after editing tests, then REQUEST-CHANGES", { outcome: "succeeded" as const, tests: "pass" as const, touchedTests: true }, { outcome: "succeeded" as const, verdict: "request-changes" as const }, 0],
    ["no tests, APPROVE", { outcome: "succeeded" as const, tests: "none" as const }, { outcome: "succeeded" as const, verdict: "approve" as const }, 1],
    ["no tests, a reviewer that succeeded with a comment", { outcome: "succeeded" as const }, { outcome: "succeeded" as const, verdict: "comment" as const }, 1],
    ["no tests, a reviewer that failed", { outcome: "succeeded" as const }, { outcome: "failed:other" as const }, undefined],
    ["no tests and no reviewer", { outcome: "succeeded" as const }, undefined, undefined],
  ])("%s", (_name, run, reviewer, expected) => {
    expect(reward(run, reviewer)).toBe(expected as 0 | 1 | undefined)
  })
})

describe("assessmentStats", () => {
  const NOW = 100 * 24 * 60 * 60 * 1000
  let id = 0
  const run = (fields: Partial<OutcomeRecord>): OutcomeRecord => ({
    v: 2,
    at: NOW - 1000 + id++,
    agent: "coder",
    tier: "standard",
    model: CONTROL,
    parentID: `parent-${id}`,
    resumes: 0,
    steps: 1,
    ms: 10,
    outcome: "succeeded",
    tests: "pass",
    policy: "explore-v1",
    eligible: [CONTROL, ARM],
    arm: CONTROL,
    p: 0.95,
    ...fields,
  })
  const times = (n: number, fields: Partial<OutcomeRecord>) => Array.from({ length: n }, () => run(fields))

  test("weights each run by 1/p, so runs drawn under a smaller ε count more", () => {
    // Arm: 20 runs at p=0.025 (w=40), 18 passing; 20 at p=0.05 (w=20), 10 passing.
    // Hájek rate (40·18 + 20·10) / (40·20 + 20·20) = 920/1200 = 0.7667 (unweighted 28/40 = 0.7);
    // Kish n = 1200² / (20·40² + 20·20²) = 36. Control: 100 runs at p=0.9, 50 passing.
    // Reference: statsmodels newcomb(27.6, 36, 50, 100) lower bound 0.0803858962.
    const records = [
      ...times(18, { arm: ARM, p: 0.025 }),
      ...times(2, { arm: ARM, p: 0.025, outcome: "failed:other" }),
      ...times(10, { arm: ARM, p: 0.05 }),
      ...times(10, { arm: ARM, p: 0.05, outcome: "failed:other" }),
      ...times(50, { p: 0.9 }),
      ...times(50, { p: 0.9, outcome: "failed:other" }),
    ]
    const [stats] = assessmentStats(records, { now: NOW })
    const a = assess(stats as GroupStats, POLICY)
    expect(a).toMatchObject({ decision: "keep", reason: "cost" })
    const e = a.decision === "keep" ? a.evidence : undefined
    expect(e?.n).toBe(40)
    expect(e?.armRate).toBeCloseTo(920 / 1200, 12)
    expect(e?.controlRate).toBeCloseTo(0.5, 12)
    expect(e?.lower).toBeCloseTo(0.0803858962, 8)
  })

  test("a different-vendor reviewer after the run scores it; a same-vendor one does not", () => {
    const records = [
      run({ parentID: "a", tests: "none", arm: "openai/gpt-5", at: NOW - 500 }),
      run({ parentID: "a", agent: "code-reviewer", tier: "reviewer", model: "anthropic/claude-opus-4", verdict: "request-changes", at: NOW - 400, policy: undefined, eligible: undefined, arm: undefined }),
      run({ parentID: "b", tests: "none", arm: "openai/gpt-5", at: NOW - 500 }),
      run({ parentID: "b", agent: "code-reviewer", tier: "reviewer", model: "openai/gpt-5", verdict: "approve", at: NOW - 400, policy: undefined, eligible: undefined, arm: undefined }),
    ]
    const [stats] = assessmentStats(records, { now: NOW })
    expect(stats?.unscored).toBe(1)
    expect(stats?.arms).toEqual([expect.objectContaining({ arm: "openai/gpt-5", n: 1, sumWR: 0 })])
  })

  test("runs that left their arm or ended at the hold timeout are not counted; the newest run names the control", () => {
    const records = [
      run({ arm: ARM, p: 0.05, failedOver: true }),
      run({ arm: ARM, p: 0.05, leftArm: true }),
      run({ arm: ARM, p: 0.05, heldExpired: true }),
      run({ eligible: [ARM, CONTROL], arm: ARM, p: 0.95 }),
    ]
    const [stats] = assessmentStats(records, { now: NOW })
    expect(stats?.control).toBe(ARM)
    expect(stats?.arms).toEqual([expect.objectContaining({ arm: ARM, n: 1 })])
  })
})

describe("assessmentText", () => {
  const evidence = { arm: ARM, n: 30, controlN: 40, armRate: 0.9, controlRate: 0.819, diff: 0.081, lower: 0.053, upper: 0.2, armCostPerSuccess: 0.12, controlCostPerSuccess: 0.14 }
  test.each<[Assessment, string]>([
    [{ decision: "keep", reason: "runs", control: CONTROL, n: 12, minN: 30, margin: 0.05, unscored: 0 }, "keep (n=12/30)"],
    [{ decision: "recommend", control: CONTROL, arm: ARM, evidence, unscored: 2 }, `recommend ${ARM}: +8.1 pts (95% LB +5.3), cost/success $0.120 vs $0.140; 2 runs without a reward signal`],
    [{ decision: "keep", reason: "interval", control: CONTROL, n: 30, minN: 30, margin: 0.05, evidence: { ...evidence, lower: -0.02 }, unscored: 0 }, `keep: ${ARM} +8.1 pts (95% LB -2.0), LB not above the 5.0-pt margin`],
  ])("%#", (a, line) => {
    expect(assessmentText(a)).toBe(line)
  })
})
