# Fan-out delivery

The lead is the user's bridge: it plans, splits, dispatches, integrates, verifies and reports, and owns the decisions put to the user. Units include independent setup, provisioning and research work, not only code changes. The lead does unit work itself only for a single unit or a shared prerequisite. A step that needs the user's credentials, approval or a console is no unit: surface it to the user.

## Split

- FO-1: split work into units only when all hold: the units are independent (established from source, imports, contracts and tests, never from titles), write no shared file, region or state, need no fixed order, and each carries meaningful work (a whole acceptance criterion or file group, never one trivial edit). Otherwise keep the work whole: one causal chain, one root-cause investigation, or a shared write stays with one agent.
- FO-2: give each shared region (contract, schema, registry, generated artifact, shared config) one owner unit. Only units that need its output wait for it.

## Dispatch

- FO-3: with 2 or more independent ready units, start the lesser of the unit count and 8 as `subagent` calls with `background: true` in one turn, and queue the rest for the next batch. Never serialize independent units. Background results arrive in your inbox; keep working until they do.
- FO-4: every brief is self-contained; subagents share no conversation. State the goal, exact target files, contracts, observable acceptance, material failure risks and proof responsibilities. Include "run only the focused commands needed to prove your own change; skip repository-wide builds, test suites, linters and formatters, which the lead runs after integration". A worker's focused result is not whole-system verification.
- Pass the pre-implementation reuse research in each code-work brief: current paths and symbols, library sources and versions, candidate decisions and open gaps, so workers do not repeat searches.
- FO-5: read each bead's `execution_agent_type` metadata before dispatching, and dispatch to the agent it names. The default is `implementer`; use `implementer-high` only when the bead says so, or a bead-less brief states root-cause or debugging work, concurrency or data-integrity logic, cross-module contract changes, algorithmic or numeric precision rules, or design judgment beyond the bead text. Never pin a higher tier for a bead without that metadata.

## Helpers

| Need | Helper |
|---|---|
| Broad read-only lookup across unknown files | `explore` |
| Risky diff (security, data loss, concurrency, public contract) | `pr-reviewer`, before landing |
| External question that needs cited sources | `researcher` |
| One exact, judgment-free command over named paths | `operator` |
| Landing one approved PR | `shepherd`, or `delivery_land` yourself |
| A few reads, one grep, or one script answers it | none: do it inline |

## Isolate and integrate

- FO-6: when two or more agents edit concurrently, give each its own linked worktree cut from one recorded base commit. Integrate each finished branch into the lead branch by merge. A conflict means the split overlapped: resolve it once in the lead branch against both units' acceptance criteria.
- FO-7: verify worker claims against the diff, then run the repository-wide verification once after integration, in the lead branch. A red result is the lead's: dispatch a targeted fix and verify again before landing (see the `delivery-git-workflow` skill).
- Subagent results from delivery agents start with `VERDICT:`; the parsed verdict is in the result's `metadata.delivery`. A `MALFORMED` verdict means ask that session again for its report.
