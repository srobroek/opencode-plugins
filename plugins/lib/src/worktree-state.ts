/**
 * What makes a worktree unsafe to remove even when `git status --porcelain` is empty:
 * an operation in progress (merge, rebase, cherry-pick, revert, bisect) and stash
 * entries made on its branch. Shared by `delivery_cleanup` and the subagent-worktree
 * lane pass so both apply one definition of "clean".
 */

/** Entries in a worktree's own git directory that mean an operation is in progress. */
export const OPERATION_MARKERS: readonly { name: string; operation: string }[] = [
  { name: "MERGE_HEAD", operation: "merge" },
  { name: "rebase-merge", operation: "rebase" },
  { name: "rebase-apply", operation: "rebase" },
  { name: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
  { name: "REVERT_HEAD", operation: "revert" },
  { name: "BISECT_LOG", operation: "bisect" },
]

/** The operations in progress, given which marker names exist in the git directory. */
export function operationsInProgress(present: ReadonlySet<string> | readonly string[]): string[] {
  const names = new Set(present)
  return [...new Set(OPERATION_MARKERS.filter((marker) => names.has(marker.name)).map((marker) => marker.operation))]
}

/** Stash subjects (`git stash list --format=%gs`) made on `branch`: "WIP on <branch>: …" or "On <branch>: …". */
export function stashesOnBranch(subjects: string, branch: string): string[] {
  return subjects
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`WIP on ${branch}:`) || line.startsWith(`On ${branch}:`))
}
