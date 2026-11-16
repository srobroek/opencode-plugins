import { describe, expect, test } from "bun:test"
import { cleanupHolds, landedHeadForLane, laneForLanding, readLanding } from "./landing.ts"
import type { Lane } from "./lane.ts"

const lane = (child: string, directory: string, state: Lane["state"] = "active"): Lane => ({
  child,
  parent: "ses_p",
  projectID: "prj",
  directory,
  branch: `lane-${child}`,
  base: "b".repeat(40),
  parentDir: "/repo",
  state,
})
const lanes = [lane("c1", "/wt/one"), lane("c2", "/wt/two")]

describe("laneForLanding", () => {
  test("a cleanup output that removed the worktree finds its lane", () => {
    expect(laneForLanding({ output: { ok: true, worktree: "/wt/two" } }, lanes)?.child).toBe("c2")
  })

  test("a land output whose inline cleanup removed it finds its lane", () => {
    expect(laneForLanding({ metadata: { ok: true, cleanup: { ok: true, removed: "/wt/one" } } }, lanes)?.child).toBe("c1")
  })

  test("JSON text in a content part is read", () => {
    const content = [{ type: "text", text: JSON.stringify({ ok: true, worktree: "/wt/two" }) }]
    expect(laneForLanding({ content }, lanes)?.child).toBe("c2")
  })

  test("the prose of delivery_cleanup is read", () => {
    const content = "delivery_cleanup removed /wt/one and branch feat/x; remote branch absent.\nreceipt: /r"
    expect(laneForLanding({ content }, lanes)?.child).toBe("c1")
  })

  test("a path compares canonically", () => {
    const canonical = (path: string) => path.replace("/private", "")
    expect(laneForLanding({ output: { ok: true, worktree: "/private/wt/one" } }, lanes, canonical)?.child).toBe("c1")
  })

  test("a named path that is gone counts, one that still exists does not", () => {
    const result = { output: { ok: false, receipt: { worktree: { path: "/wt/one" } } } }
    expect(laneForLanding(result, lanes, (p) => p, (p) => p === "/wt/one")?.child).toBe("c1")
    expect(laneForLanding(result, lanes)).toBeUndefined()
  })

  const nothing: Array<[string, unknown]> = [
    ["a refusal", { output: { ok: false, reason: "dirty" } }],
    ["a deferred land", { output: { ok: true, cleanup: { ok: false, deferred: "lane x still active" } } }],
    ["unrelated text", { content: "hello" }],
    ["nothing", undefined],
    ["a non-lane path", { output: { ok: true, worktree: "/wt/other" } }],
  ]
  for (const [name, result] of nothing) {
    test(`${name} finds nothing`, () => {
      expect(laneForLanding(result, lanes)).toBeUndefined()
    })
  }

  test("a lane that is not active is skipped", () => {
    expect(laneForLanding({ output: { ok: true, worktree: "/wt/one" } }, [lane("c1", "/wt/one", "landed")])).toBeUndefined()
  })
})

test("a deferred land's receipt gives the head that proves the lane landed", () => {
  const result = { output: { ok: true, receipt: { pr: { headRefOid: "abc" }, worktree: { path: "/wt/one" } } } }
  expect(readLanding(result).receipt).toEqual({ worktree: "/wt/one", head: "abc" })
  expect(landedHeadForLane(result, lanes)).toEqual({ lane: lane("c1", "/wt/one"), head: "abc" })
})

test("a hold is made for each lane with an unmet condition", () => {
  const holds = cleanupHolds(lanes, (candidate) => (candidate.child === "c1" ? "the child is still running" : undefined))
  expect(holds).toEqual([{ directory: "/wt/one", reason: "lane lane-c1 still active" }])
})
