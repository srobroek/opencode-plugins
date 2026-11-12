---
name: quality-testing
description: "Load before answering how to test code, or planning, writing, reviewing or pruning tests: doubles, flakes, coverage."
---

# Testing strategy

Language-neutral rules for what to test, how many tests to keep, and how tests change
with the code. For a language's runner, idioms and tool choices, also load the
`lang-<language>-testing` skill and its `references/practice.md` when one is listed;
if none is, follow the project's existing tests and test configuration. The test-first
loop and evidence rules are in the `quality-code-design` skill's `test-first.md` and
`verification.md` references.

## Workflow

1. Read the existing tests next to the code: runner, layout, helpers, fixtures,
   naming. New tests follow them.
2. List the behaviors the change adds, changes or removes: the contract at the public
   boundary, edge cases, error paths, and the bug being fixed.
3. Search the existing tests for each behavior. Decide per behavior: add a test, update
   a test, delete a test, or add nothing because a test already protects it.
4. Pick the lowest level that can catch each failure.
5. Work test-first where the change allows: write one failing test, watch it fail for
   the expected reason, make it pass with the least code, refactor, repeat.
6. Run the touched tests and the suite the project gates on. Report a test that did not
   run as not run.
7. Before hand-off, read the test diff beside the code diff with
   [review-tests.md](references/review-tests.md).

## Rules

- Test one behavior per test through the public interface. Work the expected value out
  apart from the code.
- Make every test protect a distinct risk. Parametrize cases that differ only in data,
  and delete a case that another test already covers.
- A refactor leaves behavior tests unchanged. Removed behavior takes its tests,
  fixtures, helpers and snapshots with it, in the same change.
- Never write a test that only checks that code, an export or a file is gone, that
  mirrors the implementation, that re-checks what the compiler or type checker proves,
  or that exists only to raise coverage.
- Never weaken an assertion, edit an expected value to match new output, skip a test or
  update a snapshot to get green without a requirement that says the behavior changed.

## References

| Read when | Reference |
| --- | --- |
| Writing a test, or judging whether one is worth keeping: structure, names, expected values, shared setup, test data, snapshots, test smells | [good-tests.md](references/good-tests.md) |
| Choosing a test level, or deciding that something needs no test | [what-to-test.md](references/what-to-test.md) |
| A behavior collects many tests, tests come from an agent or a generator, or the suite grows faster than the code | [test-budget.md](references/test-budget.md) |
| Changing, removing or refactoring tested code; bug fixes, legacy code, flaky tests | [maintenance.md](references/maintenance.md) |
| Choosing a fake, stub, spy or mock | [doubles.md](references/doubles.md) |
| Coverage, mutation testing, property tests, fuzzing | [signals.md](references/signals.md) |
| Reviewing the test changes in a diff or pull request | [review-tests.md](references/review-tests.md) |
