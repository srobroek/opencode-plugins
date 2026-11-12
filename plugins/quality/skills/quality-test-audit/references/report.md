# Plan and report templates

Read in steps 4, 6 and 8 of the audit.

## Plan table

One row per candidate. Keep the evidence short and checkable: a count, a mutant id, a
file and line.

| # | Test | Class | Evidence | Protects | Kept by | Action | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `tests/test_cart.py::test_total_two_items` | Copied cases | Same shape as `test_total_one_item`, `test_total_three_items` | Cart total | The merged parametrized test | Merge into `test_total[...]` | None |
| 2 | `src/billing.test.ts > legacy export is gone` | Removal check | Asserts `"legacyTotal" in mod` is false | Nothing | Not needed | Delete | None |
| 3 | `pkg/store/store_test.go:TestSaveCallsDB` | Coupled to the implementation | Asserts mock call count; kills 0 of 4 mutants in `Save` | Save persists the record | `TestSaveThenLoad` kills all 4 | Delete | None |
| 4 | `tests/flows.rs::sync_completes` | Flaky | 3 failures in 20 runs; `tokio::time::sleep` on real time | Sync completes | Itself, after the fix | Fix with paused time | Low |
| 5 | `test_discount[...]` (new case) | Surviving mutant | `discount.py:14` `>` to `>=` survives | A total of exactly 100 gets no discount | The new case | Extend `test_discount` with `total=100, expected=0` | None |

Group the rows by action. Put every row whose risk is not "None" first.

## Recommendations

Write the recommendations as a list grouped by action, worst first. Each item names the
tests or files, the evidence and the expected gain. Include them even when the user
applies nothing.

- **Drop:** tests to delete, with the test that keeps each one's protection.
- **Merge:** copied tests to fold into parametrized ones.
- **Rewrite:** tests to move to the public interface, a real object or a fake.
- **Simplify:** tests to make readable: hidden data to build in the test, large shared
  fixtures to replace with builders, helpers that hide the action or the expected values.
- **Fix:** flaky tests and their causes; weak assertions to make exact.
- **Add:** the behaviors that no test protects, and the existing test to extend for each.
- **Speed up:** the slowest tests and the cost behind each.
- **Clean up:** unused snapshots, fixtures, builders and test data; expired quarantines.
- **Suite practices:** runner settings, CI lanes, coverage settings, shared setup,
  conventions and missing tools, from the catalog's Suite practices list.

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

Recommendations not applied
  <action>: <tests or files>, <evidence>, <expected gain>

Gaps
  <what was not measured, and why>

Follow-ups
  <quarantined tests with issue, owner and expiry; slow tests left; tools to add>
```

State each number with the command or tool that produced it. Mark a manual comparison as
manual.
