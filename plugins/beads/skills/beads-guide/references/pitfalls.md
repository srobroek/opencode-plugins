# Beads pitfalls

## A bead landed in the wrong ledger

- **Symptom:** `bd create` succeeds, but the new id carries another repository's prefix, or `bd show <id>` in the target repo says the bead does not exist.
- **Cause:** `bd` uses the ledger of the directory it runs in. A shell call with no `workdir` runs in the session directory, which may be a different repo.
- **Fix:** Pass the target repo as the shell tool's `workdir` on every `bd` call. Before creating, run `bd where` and check the prefix matches the repo. Move a misplaced bead by recreating it in the right ledger and closing the stray one with a reason.

## A repo with `.beads/RETIRED` has no ledger

- **Symptom:** `.beads/RETIRED` exists in the repo, or `bd create` was about to run there.
- **Cause:** The regular-file `RETIRED` marker opts the repo out of Beads. There is no ledger to hold a bead.
- **Fix:** Create no bead anywhere for work in that repo. See the retired-ledger entry in the delivery-git-workflow skill's `references/pitfalls.md` for the PR rules.

## The gate refuses a command that starts with `cd`

- **Symptom:** `cannot resolve the dynamic working directory before this mutation`
- **Cause:** The gate must know which ledger a `bd` mutation targets. `cd dir && bd ...` changes the directory inside the command, where the gate cannot read it.
- **Fix:** Never `cd` in a command. Pass the directory as the shell tool's `workdir` and run the bare `bd` command.
