import { describe, expect, test } from "bun:test"
import type { OutcomeRecord } from "./ledger.ts"
import { formatUsage, summarizeUsage, usageBrief } from "./report.ts"

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

const rec = (over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  v: 2,
  at: NOW - DAY,
  agent: "explore",
  tier: "cheap",
  model: "p/m",
  parentID: "ses_p",
  resumes: 0,
  inputTokens: 100,
  outputTokens: 10,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0.1,
  steps: 1,
  ms: 1000,
  outcome: "succeeded",
  ...over,
})
const unreported = { inputTokens: undefined, outputTokens: undefined, reasoningTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined, cost: undefined }
const only = (records: OutcomeRecord[], days?: number) => summarizeUsage(records, NOW, days).tiers[0]?.total

describe("summarizeUsage", () => {
  test("no records gives no rows", () => {
    expect(summarizeUsage([], NOW)).toEqual({ days: 90, tiers: [] })
  })

  test("counts outcomes, success rate, failover rate and resumes; unfinished records are skipped", () => {
    const total = only([
      rec(),
      rec(),
      rec({ outcome: "failed:server", failedOver: true, resumes: 2 }),
      rec({ outcome: "interrupted" }),
      rec({ outcome: undefined }),
    ])
    expect(total).toMatchObject({ n: 4, succeeded: 2, failed: 1, interrupted: 1, successRate: 0.5, failoverRate: 0.25, resumes: 2 })
  })

  test.each([
    // ms values, p50, p90 (nearest rank)
    [[5], 5, 5],
    [[10, 20, 30, 40], 20, 40],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, 9],
    [[30, 10, 20], 20, 30],
  ])("elapsed %j: p50 %d, p90 %d", (ms, p50, p90) => {
    const total = only(ms.map((m) => rec({ ms: m })))
    expect(total?.ms).toEqual({ mean: ms.reduce((a, b) => a + b, 0) / ms.length, p50, p90 })
  })

  test("token totals, means, and cache share = read ÷ (input + read)", () => {
    const total = only([
      rec({ inputTokens: 100, outputTokens: 10, reasoningTokens: 4, cacheReadTokens: 300, cacheWriteTokens: 20 }),
      rec({ inputTokens: 300, outputTokens: 30, reasoningTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 }),
    ])
    expect(total?.tokens).toEqual({
      total: { input: 400, output: 40, reasoning: 4, cacheRead: 400, cacheWrite: 20 },
      mean: { input: 200, output: 20, reasoning: 2, cacheRead: 200, cacheWrite: 10 },
      cacheShare: 0.5,
    })
  })

  test("a run that reported no tokens or cost does not drag the means or totals to 0, and coverage shows it", () => {
    const total = only([rec({ inputTokens: 100, cost: 0.4 }), rec(unreported)])
    expect(total).toMatchObject({ n: 2, tokenRuns: 1, costRuns: 1, cost: 0.4 })
    expect(total?.tokens?.mean.input).toBe(100)
  })

  test("nothing reported is undefined, not 0", () => {
    const total = only([rec(unreported), rec({ ...unreported, cost: Number.NaN })])
    expect(total).toMatchObject({ tokenRuns: 0, costRuns: 0 })
    expect(total?.cost).toBeUndefined()
    expect(total?.costPerSuccess).toBeUndefined()
    expect(total?.tokens).toBeUndefined()
  })

  test("tokens are counted per field: a field nobody reported stays undefined, and means use that field's own runs", () => {
    const total = only([
      rec({ ...unreported, inputTokens: 100, outputTokens: 10 }),
      rec({ ...unreported, outputTokens: 30 }),
      rec({ ...unreported, outputTokens: 20, cacheReadTokens: 300 }),
    ])
    expect(total?.tokenRuns).toBe(3)
    expect(total?.tokens?.total).toEqual({ input: 100, output: 60, cacheRead: 300 })
    expect(total?.tokens?.mean).toEqual({ input: 100, output: 20, cacheRead: 300 })
    expect(total?.tokens?.total.reasoning).toBeUndefined()
    expect(total?.tokens?.mean.cacheWrite).toBeUndefined()
    // Only the runs that reported both input and cache read count: none here.
    expect(total?.tokens?.cacheShare).toBeUndefined()
    const both = only([rec({ ...unreported, inputTokens: 100, cacheReadTokens: 100 }), rec({ ...unreported, inputTokens: 300 }), rec({ ...unreported, cacheReadTokens: 900 })])
    expect(both?.tokens?.cacheShare).toBe(0.5)
  })

  test("a reported 0 on a current record is 0", () => {
    const total = only([rec({ cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })])
    expect(total).toMatchObject({ costRuns: 1, cost: 0, costPerSuccess: 0, tokenRuns: 1 })
    expect(total?.tokens?.total).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(total?.tokens?.cacheShare).toBeUndefined() // 0 ÷ 0
  })

  test("a legacy record (no version) reads its 0 usage as unknown but keeps a positive value", () => {
    const legacy = (over: Partial<OutcomeRecord>) => ({ ...rec(over), v: undefined })
    const zeros = legacy({ cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(only([zeros])).toMatchObject({ tokenRuns: 0, costRuns: 0 })
    const mixed = only([zeros, legacy({ cost: 0.3, inputTokens: 50, outputTokens: 0 })])
    expect(mixed).toMatchObject({ tokenRuns: 1, costRuns: 1, cost: 0.3, tokens: { total: { input: 50 } } })
    expect(mixed?.tokens?.total.output).toBeUndefined() // a legacy 0 is not a report
  })

  test("cost per success divides all cost by the successes; none without a success", () => {
    expect(only([rec({ cost: 1 }), rec({ cost: 2, outcome: "failed:other" })])).toMatchObject({ cost: 3, costPerSuccess: 3 })
    const none = only([rec({ cost: 1, outcome: "failed:other" })])
    expect(none?.cost).toBe(1)
    expect(none?.costPerSuccess).toBeUndefined()
  })

  test("cost per success counts only records with a known cost", () => {
    // 10 for two costed successes; a success with no cost and a costed failure add no successes.
    const total = only([rec({ cost: 4 }), rec({ cost: 6 }), rec({ cost: undefined }), rec({ cost: 5, outcome: "failed:other" })])
    expect(total).toMatchObject({ cost: 15, costRuns: 3, n: 4 })
    expect(total?.costPerSuccess).toBe(7.5)
  })

  test("the window defaults to 90 days and takes days", () => {
    const records = [rec({ at: NOW - 2 * DAY }), rec({ at: NOW - 10 * DAY }), rec({ at: NOW - 89 * DAY }), rec({ at: NOW - 91 * DAY })]
    expect(only(records)?.n).toBe(3)
    expect(only(records, 7)?.n).toBe(1)
    expect(summarizeUsage(records, NOW, 7).days).toBe(7)
    expect(only(records, 0)?.n).toBe(3)
  })

  test("tiers sort by name, agents by runs then name; records without a tier group apart", () => {
    const report = summarizeUsage(
      [
        rec({ tier: "strong", agent: "plan" }),
        rec({ agent: "zed" }),
        rec({ agent: "build" }),
        rec({ agent: "build" }),
        rec({ agent: "alpha" }),
        rec({ tier: undefined, agent: "x" }),
      ],
      NOW,
    )
    expect(report.tiers.map((t) => t.tier)).toEqual(["(none)", "cheap", "strong"])
    expect(report.tiers[1]?.agents.map((a) => [a.agent, a.n])).toEqual([
      ["build", 2],
      ["alpha", 1],
      ["zed", 1],
    ])
    expect(report.tiers[1]?.total.n).toBe(4)
  })
})

describe("formatUsage", () => {
  test("a tier line with every figure, then at most 3 agents", () => {
    const records = [
      rec({ inputTokens: 300, outputTokens: 50, cacheReadTokens: 100, cost: 0.5, ms: 2000 }),
      rec({ agent: "b", outcome: "failed:server", failedOver: true, cost: 0.25, ms: 4000 }),
      rec({ agent: "c" }),
      rec({ agent: "d" }),
      rec({ agent: "e" }),
    ]
    const lines = formatUsage(summarizeUsage(records, NOW))
    expect(lines).toEqual([
      "Usage per tier (last 90 days):",
      "  cheap: 5 runs: 4 ok, 1 failed, 0 interrupted (80%), time mean 1.8s p50 1s p90 4s, in 700 out 90 reasoning 0 cache r100/w0 (13% read), cost $1.05 ($0.263/success), failover 20%, 0 resumes",
      "    - b: 1 run · 0% ok · p50 4s · $0.250",
      "    - c: 1 run · 100% ok · p50 1s · $0.100",
      "    - d: 1 run · 100% ok · p50 1s · $0.100",
      "    - 2 more agents",
    ])
  })

  test("partial reporting shows coverage, like cost 1/2", () => {
    const [, line] = formatUsage(summarizeUsage([rec({ cost: 1 }), rec(unreported)], NOW))
    expect(line).toContain("tokens 1/2: in 100")
    expect(line).toContain("cost 1/2 $1.00 ($1.00/success)")
    expect(usageBrief(summarizeUsage([rec({ cost: 1 }), rec(unreported)], NOW).tiers[0]?.total as never)).toBe("2 runs · 100% ok · p50 1s · $1.00 1/2")
  })

  test("shows n/a for what was not reported, and a note when empty", () => {
    const [header, line] = formatUsage(summarizeUsage([rec(unreported)], NOW))
    expect(header).toBe("Usage per tier (last 90 days):")
    expect(line).toContain("tokens n/a, cost n/a (n/a/success)")
    expect(formatUsage(summarizeUsage([], NOW, 30))).toEqual(["Usage per tier (last 30 days):", "  no finished spawns recorded"])
    expect(usageBrief(summarizeUsage([rec(unreported)], NOW).tiers[0]?.total as never)).toBe("1 run · 100% ok · p50 1s · n/a")
  })
})
