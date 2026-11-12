# Plan and report templates

Read in steps 4 and 8 of the audit.

## Plan table

One row per candidate. Keep the evidence short and checkable: a count, a mutant id, a
file and line.

| # | Test | Class | Evidence | Protects | Kept by | Action | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `tests/test_cart.py::test_total_two_items` | Copied cases | Same shape as `test_total_one_item`, `test_total_three_items` | Cart total | The merged parametrized test | Merge into `test_total[...]` | None |
| 2 | `src/billing.test.ts > legacy export is gone` | Removal check | Asserts `"legacyTotal" in mod` is false | Nothing | Not needed | Delete | None |
| 3 | `pkg/store/store_test.go:TestSaveCallsDB` | Coupled to the implementation | Asserts mock call count; kills 0 of 4 mutants in `Save` | Save persists the record | `TestSaveThenLoad` kills all 4 | Delete | None |
| 4 | `tests/flows.rs::sync_completes` | Flaky | 3 failures in 20 runs; `tokio::time::sleep` on real time | Sync completes | Itself, after the fix | Fix with paused time | Low |

Group the rows by action. Put every row whose risk is not "None" first.

## Report

```text
Test audit: <scope> at <commit>

                 before   after
Tests            <n>      <n>
Runtime (median) <s>      <s>
Flaky            <n>      <n>
Line coverage    <%>      <%>
Branch coverage  <%>      <%>
Mutation score   <%>      <%>   (<tool>, <files mutated>)

Batches
  <commit>  <action> in <area>: <n> tests  (lost protection: none | <approved entries>)

Kept on purpose
  <test>: <reason>

Gaps
  <what was not measured, and why>

Follow-ups
  <quarantined tests with issue, owner and expiry; slow tests left; tools to add>
```

State each number with the command or tool that produced it. Mark a manual comparison as
manual.
