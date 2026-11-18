import { expect, test } from "bun:test"
import { operationsInProgress, stashesOnBranch } from "./worktree-state.ts"

test.each([
  [["MERGE_HEAD"], ["merge"]],
  [["rebase-merge", "rebase-apply"], ["rebase"]],
  [["CHERRY_PICK_HEAD"], ["cherry-pick"]],
  [["REVERT_HEAD"], ["revert"]],
  [["BISECT_LOG"], ["bisect"]],
  [["HEAD", "index"], []],
])("markers %p mean operations %p", (present, expected) => {
  expect(operationsInProgress(present)).toEqual(expected)
})

test("only stashes made on the branch count", () => {
  const list = "WIP on feat/a: abc msg\nOn feat/b: named\nWIP on feat/ab: x\nOn feat/a: named"
  expect(stashesOnBranch(list, "feat/a")).toEqual(["WIP on feat/a: abc msg", "On feat/a: named"])
  expect(stashesOnBranch("", "feat/a")).toEqual([])
})
