# Delivery pitfalls

## `delivery_cleanup` refuses a receipt

- **Symptom:** `delivery_cleanup` reports that the receipt names no worktree path.
- **Cause:** `delivery_land` found no worktree to record: none was passed, and no linked worktree of the session repository has the PR branch checked out at the PR head.
- **Fix:** Pass `worktree` (the PR-head worktree of the session repository) to `delivery_land`. Re-run it with the same inputs to rewrite the receipt, then run `delivery_cleanup`.

## `delivery_land` rejects `repo` or `worktree`

- **Symptom:** `repo: observed "X", expected "Y" from remote origin` or `worktree: observed "/path" as a checkout of another repository`
- **Cause:** `delivery_land` works only in the session repository. It checks `repo` against that repository's remotes and refuses a `worktree` that is not one of its own, because Git must not run in a checkout of another repository.
- **Fix:** Run `delivery_land` from a session in the PR's repository, and pass that repository's `worktree`. `repo` may name any remote of the session repository.

## `delivery_cleanup` refuses another repository or a changed worktree

- **Symptom:** `worktree.owner: observed "a receipt or worktree of a repository other than this session's"` or `worktree.marker: observed`
- **Cause:** The receipt or worktree belongs to a different repository, or the registered worktree's `.git` is now a symlink, FIFO or a file naming another repository. No Git ran in it.
- **Fix:** Run `delivery_cleanup` from a session in the receipt's repository. For `worktree.marker`, inspect the worktree's `.git` by hand and do not run Git in it until it names this repository's `worktrees/` directory.

## `gh pr checks --watch` finds no checks right after a push

- **Symptom:** `no checks reported`
- **Cause:** GitHub has not created the check runs yet, so `--watch` has nothing to watch and exits.
- **Fix:** Poll `gh pr view <pr> --json statusCheckRollup` until it lists checks, then run `gh pr checks <pr> --watch` as a background shell call.

## A retired ledger and the PR gate

- **Symptom:** `This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer.`
- **Cause:** The PR gate reads the ledger of the shell call's working directory. In a repo with a regular-file `.beads/RETIRED` it skips the check, so the message means the working directory is a different, live repo. `No-Bead:` is not accepted.
- **Fix:** Run `gh pr create` with the PR's repo as `workdir`. Add no trailer for a retired repo, create no bead, and do not use `No-Bead:`. If the gate still asks for a trailer, your `workdir` is the wrong repo.

## A draft PR reports no checks

- **Symptom:** `no checks reported` on a draft PR
- **Cause:** Expected in repositories whose workflows skip drafts and run on `ready_for_review` (for example srobroek/slopvac). Elsewhere a draft still runs CI, and marking it ready may not start a new run.
- **Fix:** Finish the work and pass local checks, then run `gh pr ready <n>`. For a fix round, run `gh pr ready <n> --undo`, push, and mark it ready again.

## Landing into a branch that requires a merge queue (interim until `delivery_land` supports merge queues)

- **Symptom:** `delivery_land` refuses, or a direct merge fails with an error like "Repository rule violations found" or "Changes must be made through the merge queue" (approximate text, not an exact diagnostic)
- **Cause:** The base branch (for example in `srobroek/slopvac`) requires a GitHub merge queue, and `delivery_land` merges directly. Interim guidance until `delivery_land` supports merge queues (PR #188). On a queue branch, `gh pr merge` enqueues only when the required checks are green; otherwise it silently enables auto-merge without `--auto`, and that stays armed across pushes.
- **Fix:** Run `gh pr merge <n> --match-head-commit <reviewed-sha>` only after the required checks are green on the reviewed head; the queue's configured merge method applies. Immediately run `gh pr view <n> --json mergeStateStatus,autoMergeRequest,headRefOid`. If `autoMergeRequest` is set, run `gh pr merge <n> --disable-auto` and report it. The docs do not say whether `--match-head-commit` binds the enqueue, so also confirm `headRefOid` equals the reviewed SHA. The repository setting deletes the branch automatically. Close the bead by hand with the PR number and merge SHA. Never pass `--auto`.
