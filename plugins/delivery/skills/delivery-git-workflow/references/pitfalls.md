# Delivery pitfalls

## `delivery_cleanup` refuses a receipt

- **Symptom:** `delivery_cleanup` reports that the receipt names no worktree path.
- **Cause:** `delivery_land` was called without `worktree`, so the receipt recorded nothing to remove.
- **Fix:** Always pass `worktree` (the PR-head worktree) to `delivery_land`. Re-run `delivery_land` with the same inputs and `worktree` to rewrite the receipt, then run `delivery_cleanup`.

## `delivery_land` rejects `repo`

- **Symptom:** `repo: observed "X", expected "Y" from remote origin`
- **Cause:** `delivery_land` checks `repo` against the origin remote of the session directory. The session cwd is another repository than the PR's.
- **Fix:** Pass the `repo` that the session cwd's origin names, or run the landing from a session whose directory is the PR's repository.

## `gh pr checks --watch` finds no checks right after a push

- **Symptom:** `no checks reported`
- **Cause:** GitHub has not created the check runs yet, so `--watch` has nothing to watch and exits.
- **Fix:** Poll `gh pr view <pr> --json statusCheckRollup` until it lists checks, then run `gh pr checks <pr> --watch` as a background shell call.

## A retired ledger and the PR gate

- **Symptom:** `This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer.`
- **Cause:** The PR gate reads the ledger of the shell call's working directory. In a repo with a regular-file `.beads/RETIRED` it skips the check, so the message means the working directory is a different, live repo. `No-Bead:` is not accepted.
- **Fix:** Run `gh pr create` with the PR's repo as `workdir`. Add no trailer for a retired repo, create no bead, and do not use `No-Bead:`. If the gate still asks for a trailer, your `workdir` is the wrong repo.
