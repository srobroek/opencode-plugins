import { describe, expect, test } from "bun:test"
import type { Finding } from "./announce.ts"
import { createAnnouncements, dismissRows } from "./announce-view.ts"

const finding = (agent: string, arm = "p/m#high", verdict: Finding["verdict"] = "recommend", tier = "strong"): Finding => ({
  tier,
  agent,
  verdict,
  arm,
  control: "p/m#low",
  pts: "+8.1",
  lb: "+5.3",
  cost: "$0.120",
  cost0: "$0.140",
  at: 1,
  seen: false,
})

/** A server double: the unseen findings, and `seen` removes one. */
function setup(initial: Finding[]) {
  let server = initial
  const toasts: string[] = []
  const counts: number[] = []
  const marked: string[] = []
  const a = createAnnouncements(
    {
      fetch: async () => server,
      seen: async (tier, agent) => {
        marked.push(`${tier}/${agent}`)
        server = server.filter((f) => !(f.tier === tier && f.agent === agent))
      },
      toast: (m) => toasts.push(m),
    },
    (n) => counts.push(n),
  )
  return { a, toasts, counts, marked, set: (next: Finding[]) => (server = next) }
}

describe("announcements view model", () => {
  test("one toast per new finding, and each only once per instance", async () => {
    const s = setup([finding("coder"), finding("plan", "p/m#max")])
    await s.a.refresh()
    expect(s.toasts).toHaveLength(2)
    expect(s.toasts[0]).toContain("coder could use p/m#high")
    await s.a.refresh()
    expect(s.toasts).toHaveLength(2)
    s.set([finding("coder"), finding("plan", "p/m#max"), finding("review", "p/m#low", "rollback")])
    await s.a.refresh()
    expect(s.toasts).toHaveLength(3)
    expect(s.toasts[2]).toContain("review's adopted p/m#low")
  })

  test("a finding whose arm changed is toasted again", async () => {
    const s = setup([finding("coder")])
    await s.a.refresh()
    s.set([finding("coder", "p/m#max")])
    await s.a.refresh()
    expect(s.toasts).toHaveLength(2)
  })

  test("toasting does not mark seen: the badge counts unseen findings", async () => {
    const s = setup([finding("coder"), finding("plan")])
    await s.a.refresh()
    expect(s.a.count()).toBe(2)
    expect(s.counts.at(-1)).toBe(2)
    expect(s.marked).toEqual([])
  })

  test("opening a tier marks its findings seen and the badge clears", async () => {
    const s = setup([finding("coder"), finding("plan"), finding("x", "p/m#high", "recommend", "cheap")])
    await s.a.refresh()
    await s.a.markSeen("strong")
    expect(s.marked).toEqual(["strong/coder", "strong/plan"])
    expect(s.a.count()).toBe(1)
    await s.a.markSeen("cheap", "x")
    expect(s.counts.at(-1)).toBe(0)
  })

  test("dismissing one agent leaves the other's finding", async () => {
    const s = setup([finding("coder"), finding("plan")])
    await s.a.refresh()
    await s.a.markSeen("strong", "coder")
    expect(s.a.count()).toBe(1)
    expect(s.marked).toEqual(["strong/coder"])
  })

  test("a failed fetch keeps the badge and toasts nothing", async () => {
    const toasts: string[] = []
    const a = createAnnouncements({ fetch: async () => Promise.reject(new Error("down")), seen: async () => {}, toast: (m) => toasts.push(m) })
    await a.refresh()
    expect(toasts).toEqual([])
  })

  test("dismiss rows, one per agent", () => {
    expect(dismissRows(["coder"]).map((r) => r.title)).toEqual(["Dismiss announcement (coder)"])
  })
})
