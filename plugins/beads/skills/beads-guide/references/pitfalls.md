# Beads pitfalls

## A bead landed in the wrong ledger

- **Symptom:** `bd create` succeeds, but the new id carries another repository's prefix, or `bd show <id>` in the target repo says the bead does not exist.
- **Cause:** `bd` uses `BEADS_DIR` when it is set, otherwise the ledger of the directory it runs in. A shell call with no `workdir` runs in the session directory, which may be a different repo; an inherited `BEADS_DIR` points at its own ledger whatever the `workdir`.
- **Fix:** Pass the target repo as the shell tool's `workdir` on every `bd` call, and make sure no foreign `BEADS_DIR` is set. Before creating, run `bd where` and check that its path and prefix belong to the repo. Move a misplaced bead by recreating it in the right ledger and closing the stray one with a reason.

## A repo with `.beads/RETIRED` has no ledger

- **Symptom:** `.beads/RETIRED` exists in the repo, or `bd create` was about to run there.
- **Cause:** The regular-file `RETIRED` marker opts the repo out of Beads. There is no ledger to hold a bead.
- **Fix:** Create no bead anywhere for work in that repo. See the retired-ledger entry in the delivery-git-workflow skill's `references/pitfalls.md` for the PR rules.

## The gate refuses a command whose directory depends on a variable

- **Symptom:** `cannot resolve the dynamic working directory before this mutation`
- **Cause:** The gate must know which ledger a `bd` mutation targets. It resolves a literal `cd <path> &&` prefix, but not a directory that comes from a variable, a command substitution or another runtime value.
- **Fix:** Pass the directory as the shell tool's `workdir` and run the bare `bd` command, rather than computing it inside the command.
