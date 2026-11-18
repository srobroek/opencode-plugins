import { describe, expect, test } from "bun:test"
import { announceFindings, badgeText, createThrottle, current, type Finding, findingKey, MAX_FINDINGS, markSeen, toastText, unseen } from "./announce.ts"
import type { AgentAssessment, Evidence } from "./assess.ts"

const evidence: Evidence = { arm: "p/m#high", n: 30, controlN: 40, armRate: 1, controlRate: 0.5, diff: 0.081, lower: 0.053, upper: 0.2, armCostPerSuccess: 0.12, controlCostPerSuccess: 0.14 }
const recommend = (agent: string, arm = "p/m#high", tier = "strong", over: Partial<AgentAssessment> = {}): AgentAssessment => ({
  tier,
  agent,
  assessment: { decision: "recommend", control: "p/m#low", arm, evidence: { ...evidence, arm }, unscored: 0 },
  text: "",
  live: "p/m#low",
  ...over,
})
const rollback = (agent: string): AgentAssessment => ({
  tier: "strong",
  agent,
  assessment: { decision: "rollback", control: "p/m#high", arm: "p/m#low", evidence: { ...evidence, arm: "p/m#low" }, unscored: 0 },
  text: "",
  live: "p/m#high",
})
const keep = (agent: string, tier = "strong"): AgentAssessment => ({ tier, agent, assessment: { decision: "keep", reason: "runs", control: "p/m#low", n: 3, minN: 30, margin: 0.02, unscored: 0 }, text: "", live: "p/m#low" })

describe("announceFindings", () => {
  test("a recommendation becomes an unseen finding with the evidence as text", () => {
    expect(announceFindings([], [recommend("coder")], 5)).toEqual([
      { tier: "strong", agent: "coder", verdict: "recommend", arm: "p/m#high", control: "p/m#low", pts: "+8.1", lb: "+5.3", cost: "$0.120", cost0: "$0.140", at: 5, seen: false },
    ])
  })

  test("the same verdict and arm again changes nothing, and a seen finding stays seen", () => {
    const once = markSeen(announceFindings([], [recommend("coder")], 5), "strong", "coder")
    expect(announceFindings(once, [recommend("coder")], 99)).toEqual(once)
  })

  test("a changed arm or verdict is announced again, unseen, and moves to the end", () => {
    const first = markSeen(announceFindings([], [recommend("coder"), recommend("other")], 1), "strong", "coder")
    const arm = announceFindings(first, [recommend("coder", "p/m#max")], 2)
    expect(arm.map((f) => [f.agent, f.arm, f.seen])).toEqual([
      ["other", "p/m#high", false],
      ["coder", "p/m#max", false],
    ])
    const verdict = announceFindings(first, [rollback("coder")], 2)
    expect(verdict.find((f) => f.agent === "coder")).toMatchObject({ verdict: "rollback", seen: false })
  })

  test("a keep clears the entry of that agent and tier only, and a later recommendation is new", () => {
    const list = markSeen(announceFindings([], [recommend("coder"), recommend("coder", "p/m#high", "cheap"), recommend("other")], 1), "strong", "coder")
    const cleared = announceFindings(list, [keep("coder")], 2)
    expect(cleared.map(findingKey)).toEqual([findingKey({ tier: "cheap", agent: "coder" }), findingKey({ tier: "strong", agent: "other" })])
    expect(announceFindings(cleared, [recommend("coder")], 3).at(-1)).toMatchObject({ agent: "coder", seen: false })
  })

  test("an assessment whose tier changed since it was assessed is not announced, and clears its entry", () => {
    const stale = recommend("coder", "p/m#high", "strong", { live: "p/m#medium" })
    expect(announceFindings([], [stale], 1)).toEqual([])
    expect(announceFindings(announceFindings([], [recommend("coder")], 1), [stale], 2)).toEqual([])
  })

  test("only the newest 50 findings are kept", () => {
    const all = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => recommend(`a${i}`))
    const list = announceFindings([], all, 1)
    expect(list).toHaveLength(MAX_FINDINGS)
    expect(list[0]?.agent).toBe("a5")
    expect(list.at(-1)?.agent).toBe(`a${MAX_FINDINGS + 4}`)
  })
})

describe("current", () => {
  test("drops a finding whose assessment is stale, changed or gone", () => {
    const list = announceFindings([], [recommend("a"), recommend("b"), recommend("c"), recommend("d")], 1)
    const now = [recommend("a"), recommend("b", "p/m#high", "strong", { live: "p/m#medium" }), recommend("c", "p/m#max"), keep("d")]
    expect(current(list, now).map((f) => f.agent)).toEqual(["a"])
  })
})

describe("texts", () => {
  const f = (a: AgentAssessment) => announceFindings([], [a], 1)[0] as Finding
  test("recommendation toast", () => {
    expect(toastText(f(recommend("coder")))).toBe("model-roles: coder could use p/m#high (+8.1 pts, 95% LB +5.3, cost/success $0.120 vs $0.140). Review in /tiers.")
  })
  test("rollback toast names the adopted arm and the previous one", () => {
    expect(toastText(f(rollback("coder")))).toBe("model-roles: coder's adopted p/m#high now trails p/m#low. Review in /tiers.")
  })
  test("badge counts unseen findings", () => {
    const list = markSeen(announceFindings([], [recommend("a"), recommend("b")], 1), "strong", "a")
    expect(unseen(list)).toHaveLength(1)
    expect(badgeText(unseen(list).length)).toBe("tiers: 1 new")
    expect(badgeText(0)).toBeUndefined()
  })
})

describe("createThrottle", () => {
  const fake = () => {
    let time = 0
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
    const advance = (ms: number) => {
      time += ms
      for (const t of timers) {
        if (!t.live || t.at > time) continue
        t.live = false
        t.fn()
      }
    }
    return {
      now: () => time,
      setTimer: (fn: () => void, ms: number) => {
        const t = { at: time + ms, fn, live: true }
        timers.push(t)
        return t
      },
      clearTimer: (h: unknown) => {
        ;(h as { live: boolean }).live = false
      },
      advance,
    }
  }

  test("runs once for a burst, then waits out the interval before the next run", async () => {
    const clock = fake()
    let runs = 0
    const t = createThrottle(async () => void runs++, { intervalMs: 60_000, ...clock })
    t.trigger()
    t.trigger()
    clock.advance(0)
    await Promise.resolve()
    expect(runs).toBe(1)
    clock.advance(10_000)
    t.trigger()
    t.trigger()
    clock.advance(49_999)
    expect(runs).toBe(1)
    clock.advance(1)
    await Promise.resolve()
    expect(runs).toBe(2)
  })

  test("a failing run is reported and does not stop later runs", async () => {
    const clock = fake()
    const errors: unknown[] = []
    let runs = 0
    const t = createThrottle(
      async () => {
        runs++
        throw new Error("x")
      },
      { intervalMs: 10, ...clock },
      (e) => errors.push(e),
    )
    t.trigger()
    clock.advance(0)
    await Bun.sleep(1)
    t.trigger()
    clock.advance(10)
    await Bun.sleep(1)
    expect([runs, errors.length]).toEqual([2, 2])
  })

  test("dispose cancels a waiting run", () => {
    const clock = fake()
    let runs = 0
    const t = createThrottle(async () => void runs++, { intervalMs: 10, ...clock })
    t.trigger()
    t.dispose()
    clock.advance(100)
    expect(runs).toBe(0)
  })
})
