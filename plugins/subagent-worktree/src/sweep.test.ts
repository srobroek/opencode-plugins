import { describe, expect, test } from "bun:test"
import { classifyWorktree, planSweep, type WorktreeFacts } from "./sweep.ts"

const DAY = 24 * 3_600_000
const options = { minAgeMs: DAY }
const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  path: "/data/worktree/prj/a",
  branch: "a",
  agentPath: true,
  exists: true,
  owner: "no",
  ageMs: 2 * DAY,
  landed: true,
  dirty: false,
  ahead: 2,
  unpushed: false,
  ...over,
})

describe("classifyWorktree", () => {
  const rows: Array<[string, Partial<WorktreeFacts>, string, string]> = [
    ["squash-merged and clean", {}, "prune", "landed and clean"],
    ["tip moved after the merge", { landed: false }, "keep", "not landed"],
    ["dirty", { dirty: true }, "quarantine", "landed but dirty"],
    ["dirty and not landed", { landed: false, dirty: true }, "quarantine", "uncommitted"],
    ["unpushed commits, not landed", { landed: false, unpushed: true }, "quarantine", "unpushed"],
    ["unknown owner", { owner: "unknown" }, "keep", "owner unknown"],
    ["live owner", { owner: "yes" }, "keep", "live session"],
    ["non-agent path", { agentPath: false }, "keep", "not an agent worktree"],
    ["too young", { ageMs: DAY / 2 }, "keep", "too young"],
    ["age unknown", { ageMs: undefined }, "keep", "too young"],
    ["directory gone", { exists: false }, "prune-registry", "gone"],
    ["unreadable state", { dirty: undefined }, "keep", "unreadable"],
    ["nothing to land", { landed: false, ahead: 0 }, "keep", "no work"],
  ]
  test.each(rows)("%s", (_name, over, verdict, reason) => {
    const result = classifyWorktree(facts(over), options)
    expect(result.verdict).toBe(verdict as never)
    expect(result.reason).toContain(reason)
  })

  test("a pruned worktree deletes its branch only on the landed proof", () => {
    expect(classifyWorktree(facts(), options).deleteBranch).toBe(true)
    expect(classifyWorktree(facts({ landed: false }), options).deleteBranch).toBeUndefined()
  })

  test("a non-agent path is kept even when its directory is gone", () => {
    expect(classifyWorktree(facts({ agentPath: false, exists: false }), options).verdict).toBe("keep")
  })
})

test("planning twice over the same facts gives the same plan, ordered and without duplicates", () => {
  const list = [facts({ path: "/z" }), facts({ path: "/a", dirty: true }), facts({ path: "/z" })]
  const first = planSweep(list, options)
  expect(first.map((entry) => [entry.path, entry.verdict])).toEqual([
    ["/a", "quarantine"],
    ["/z", "prune"],
  ])
  expect(planSweep(list, options)).toEqual(first)
})
