# Beads pitfalls

## A bead landed in the wrong ledger

- **Symptom:** `bd create` succeeds, but the new id has another repository's prefix. Or `bd show <id>` in the target repo reports that the bead does not exist.
- **Cause:** With `BEADS_DIR` set, `bd` uses that ledger. Without it, `bd` uses the ledger of the directory it runs in. A shell call with no `workdir` runs in the session directory, which can be a different repo. An inherited `BEADS_DIR` points at its own ledger for any `workdir`.
- **Fix:** Pin every `bd` call to the target ledger:
  1. On every `bd` call, pass the target repo as the shell tool's `workdir`.
  2. Make sure that no foreign `BEADS_DIR` is in the environment.
  3. Before you create a bead, run `bd where`. Check that its path and prefix belong to the repo.
  4. To move a misplaced bead, create it again in the correct ledger. Then close the stray bead with a reason.

## A repo with `.beads/RETIRED` has no ledger

- **Symptom:** `.beads/RETIRED` exists in the repo, or `bd create` was about to run there.
- **Cause:** The regular-file `RETIRED` marker opts the repo out of Beads. No ledger exists to hold a bead.
- **Fix:** For work in that repo, create no bead in any ledger. For the PR rules, see the retired-ledger entry in the delivery-git-workflow skill's `references/pitfalls.md`.

## The gate stops a command whose directory depends on a variable

- **Symptom:** `cannot resolve the dynamic working directory before this mutation`
- **Cause:** The gate must know which ledger a `bd` mutation targets. It resolves a literal `cd <path> &&` prefix. It cannot resolve a directory that comes from a variable, a command substitution or another runtime value.
- **Fix:** Pass the directory as the shell tool's `workdir`, and run the bare `bd` command. Do not compute the directory inside the command.

## The ledger is busy with other writers

- **Symptom:** `The Beads ledger is busy: other writers held the embedded write lock`
- **Cause:** Many agents write to one embedded ledger, and the lock lets one writer in at a time. The wait ran out before this command got its turn.
- **Fix:** Retry the same command as its own simple command. Do not delete the lock file of a live holder. The beads-contention-retry skill has the full policy.

## The actor gate is a safety net, not a lock

- **Symptom:** An advisory says a create or claim has no `BEADS_ACTOR` or `BD_ACTOR`, or someone asks the gate to catch a wrong actor.
- **Cause:** The plugin adds `export BEADS_ACTOR='opencode/<agent>/<session>'` to every `bd` shell call that names no actor. The gate only guards against forgetting attribution. It cannot stop deliberate evasion, because an agent can set any actor value.
- **Fix:** Set `BEADS_ACTOR=<harness>/<agent>/<session>` on the command when you need your own identity. Do not add parser rules to chase shell tricks.
- **Scope:** the close, update-close and unclaim gates, the embedded-write lock and the wait guard share this scope. They catch commands an agent writes normally, not deliberately obfuscated shell.

## A claimed bead is back in `bd ready`

- **Symptom:** `bd show <id>` reports `open` with no assignee for a bead you claimed, or `bd heartbeat <id>` fails.
- **Cause:** A claim holds a five-minute lease. The plugin renews it while the session runs, but only for a claim it tracks: one plain `bd update <id> --claim` or `bd claim <id>` command with no `;`, `&&`, pipe or subshell and no ledger selector or `BEADS_DB`-style variable. A claim run any other way is not tracked, and its result says so. In an idle session the lease lapses, and `bd reclaim` returns the bead to ready. This behavior is correct.
- **Fix:** Run `bd show <id>`. If no other actor holds the bead, claim it again with `bd update <id> --claim`.
