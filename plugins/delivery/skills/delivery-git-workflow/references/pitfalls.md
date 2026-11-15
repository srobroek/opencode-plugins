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
