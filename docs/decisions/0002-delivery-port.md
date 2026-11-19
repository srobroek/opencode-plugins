# 0002. Port delivery to OpenCode V2 as tools with receipts

## Context

The omp `delivery` plugin carried the landing workflow: `delivery_land` and
`delivery_cleanup` (382 and 156 calls in the omp usage record), receipts, and
a forge adapter for `gh` and `glab`. Its safety depends on checkable facts:
the PR head, the merge shape and the receipt.

## Decision

- `delivery_land` and `delivery_cleanup` are tools with declared `output`
  schemas. Both keep the receipt-driven proofs. Land binds the merge to the
  PR head with `gh pr merge --match-head-commit` or `glab --sha`.
- Land fetches the merge commit before reading its parents. The omp version
  read them locally first and refused 43 times after merges had succeeded.
- `delivery_hygiene_report` and `worktree-reaper` are dropped. `shepherd`
  becomes a thin optional subagent.
- Subagents report a `VERDICT:` first line and a JSON block. An `execute.after`
  hook on `subagent` parses it into metadata and never blocks.
- Receipts stay on disk and keep the `omp.receipt.landing` schema id on read.

## Status

Plan, ported in `plugins/delivery`. Check that plugin's README for what
shipped.

## Consequences

- Routing uses the verdict. Safety uses the PR and the receipt, so a malformed
  verdict cannot merge anything.
- Spawning nested subagents needs `experimental.subagent_depth` of 2, which
  defaults to 1.
- If verdict parse failures exceed about 5% over two weeks, add a typed
  `delivery_report` tool input (Option B in the original analysis).
