# Beads ledger pitfalls

## A stub drifted from its contract

- **Symptom:** T's tests pass against the stub but fail against the real B in S's PR. `git grep -E 'STUB\([A-Za-z0-9._-]+\)'` finds a stub that no conformance test uses.
- **Cause:** Only the real implementation ran C's conformance runner. The stub followed the consumer's assumptions, not the contract.
- **Fix:** Wire every stub into C's runner in T's own tests, and put that in T's acceptance. If the stub and B disagree on a case outside the fixtures, add a fixture to C.

## A swap needed more than a wiring change

- **Symptom:** S's diff edits types, field names or conversions in T. `git grep` finds a second definition of a contract type.
- **Cause:** The stub used a hand-written local copy of the contract types. T used types that B does not use.
- **Fix:** Import C's generated or shared types in the stub and in T. Delete the local copy in the swap PR. If C has no shared types, add them to C.

## Generated code went stale after a contract change

- **Symptom:** A consumer rejects a new field that the schema already has. After you regenerate the types, `git diff --exit-code` fails.
- **Cause:** C has no staleness check. Generated types, docs or fixtures fell behind the contract, and no check failed.
- **Fix:** Add a CI step that regenerates every output of C and runs `git diff --exit-code`. Regenerate in the same PR as each contract change.

## Ready swap beads stayed idle

- **Symptom:** `bd ready --label stub` lists swap beads, and the orchestrator ends its turn on a CI watch with idle writers.
- **Cause:** After a C, B or T closed, no agent ran `bd ready`. The agent treated a CI watch as work.
- **Fix:** After each close, run `bd ready --label stub` for the affected workstreams. Before you end the turn, start the ready swap beads.

## A consumer stays out of `bd ready`

- **Symptom:** `bd dep list <T>` shows the producer B `via blocks`. T stays out of `bd ready` after C closes.
- **Cause:** The plan gave T a hard edge on B, not on C. A `blocks` edge hides its dependent until the blocker closes.
- **Fix:** Check that T and B both depend on C with `bd dep add T C` and `bd dep add B C`. Then run `bd dep remove T B` and `bd dep add T B --type related`. Then file the swap bead with edges 3 and 4 from [contracts-and-stubs.md](contracts-and-stubs.md).

## A swap bead was ready before its stub landed

- **Symptom:** While T is open, `bd ready --label stub` lists S. `git grep 'STUB(<S-id>)'` finds nothing on the main branch.
- **Cause:** The plan has no edge 4. S depends on B but not on T.
- **Fix:** Run `bd dep add S T`.

## A swap bead was ready before the contract change it needs

- **Symptom:** `bd ready --label stub` lists S, but B still rejects the value S needs. C's runner fails on S's branch.
- **Cause:** Edge 3 points at a broad epic or an earlier bead. It does not point at the bead that delivers the change.
- **Fix:** Run `bd dep remove S <old>` and `bd dep add S <bead-that-delivers-the-change>`.

## A stub count reads zero for a list of statuses

- **Symptom:** `bd count --label stub --status open,in_progress` prints `0`, but `bd list` with the same filters lists stub beads.
- **Cause:** In bd 1.3.1, `bd count` returns 0 for a comma-separated status list. `bd count --status open` alone counts correctly.
- **Fix:** Count with `bd list --label stub --status open,in_progress,blocked,deferred --limit 0 --json | jq length`. The `--limit 0` lifts the default cap of 50 results.
