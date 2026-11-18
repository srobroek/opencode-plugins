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
    ["closed unmerged and clean", { landed: false, closed: true }, "prune", "closed without merging"],
    ["closed unmerged but dirty", { landed: false, closed: true, dirty: true }, "quarantine", "uncommitted"],
    ["closed unmerged with a live owner", { landed: false, closed: true, owner: "yes" }, "keep", "live session"],
    ["closed unmerged with an unknown owner", { landed: false, closed: true, owner: "unknown" }, "keep", "owner unknown"],
    ["closed unmerged but too young", { landed: false, closed: true, ageMs: DAY / 2 }, "keep", "too young"],
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

  test("a closed-unmerged prune keeps the branch; a merged one deletes it", () => {
    const closed = classifyWorktree(facts({ landed: false, closed: true }), options)
    expect(closed.deleteBranch).toBeUndefined()
    expect(closed.closedUnmerged).toBe(true)
    expect(classifyWorktree(facts(), options).closedUnmerged).toBeUndefined()
  })

  test("an open or unknown pull request leaves an unlanded worktree as it was", () => {
    expect(classifyWorktree(facts({ landed: false, closed: false }), options).verdict).toBe("keep")
    expect(classifyWorktree(facts({ landed: false }), options).verdict).toBe("keep")
  })

  test("build directories are offered for a kept worktree, never for a pruned one", () => {
    expect(classifyWorktree(facts({ landed: false, freeBuild: true }), options).freeBuild).toBe(true)
    expect(classifyWorktree(facts({ freeBuild: true }), options).freeBuild).toBeUndefined()
    expect(classifyWorktree(facts({ landed: false }), options).freeBuild).toBeUndefined()
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
