# Reviewing test changes

Read when you review a diff or a pull request that touches code or tests, or before you
hand off your own change. Review the test diff against the code diff, not each one
alone.

## Map test changes to code changes

Classify each code hunk, then look for the matching test change.

| Code change | Expect in the test diff | Flag |
| --- | --- | --- |
| New behavior | A test for each behavior, at the lowest level that catches the fault | A behavior with no test that would fail without it |
| Bug fix | A regression test that reproduces the bug | No regression test, or one that passes without the fix |
| Changed requirement | Updated expected values, and a stated requirement in the commit, pull request or spec | Expected values changed with no stated reason |
| Refactor that keeps behavior | No assertion changes; mechanical edits only | Rewritten assertions: the behavior changed, or the tests were coupled to structure |
| Removed behavior | Its tests, fixtures, helpers and snapshots deleted | Tests or fixtures left behind; a new test that only checks that the code is gone |
| Docs, config or formatting only | Nothing | Test edits with no reason |
| Test-only change | A named reason: a missing case, a flake fix, pruning | Deleted or weakened tests without a reason, or without a remaining test that gives the same protection |

## Check each added or changed test

1. It maps to a named behavior, requirement or bug.
2. It goes through the public interface. It does not test private helpers, call order or
   internal state.
3. It tests one behavior with one logical outcome. Its inputs, action and expected
   values are readable in the test body.
4. Its expected values do not repeat the implementation and are not pasted output.
5. It does not repeat an existing test. Cases with the same shape are parametrized.
6. Doubles sit at boundaries. Nothing doubles the code under test. Interaction checks
   appear only where the call is the behavior.
7. It is deterministic: no sleeps, real clock, unseeded randomness or shared state.
8. Snapshots are small, and the diff of each updated snapshot was reviewed.
9. It is not on the "do not test" list in [what-to-test.md](what-to-test.md).
10. It ran. A regression test failed before the fix. When you cannot run tests, name the
    command for the author to run.

With access to the diff only, judge duplicates within the diff, and say what you could
not check.

## Tampering

Tampering hides a behavior change or loses protection. Flag each of these when no
requirement states that the behavior changed:

- an assertion loosened, such as an exact value replaced by a not-null or a contains
  check;
- an expected value edited to match the new output;
- a test skipped, deleted, or marked as an expected failure, with no remaining test that
  gives its protection;
- a tolerance widened, a timeout raised, or a retry added;
- an exception handler that swallows a failure inside a test;
- a coverage exclusion added;
- many snapshots updated in one step without a reviewed diff.

Maintenance is not tampering. Pruning a duplicate that another test covers, deleting
the tests of removed behavior, and a quarantine with a tracked issue and a lane that
still runs the test are correct changes ([maintenance.md](maintenance.md)).

## Severity

| Finding | Disposition |
| --- | --- |
| Tampering that hides a behavior change or loses protection | Blocking |
| Changed behavior or a bug fix with no test that fails without it, in code that has tests | Blocking |
| A new test that only checks that removed code, an export or a file is gone | Blocking |
| Tests or fixtures left behind for removed behavior | Non-blocking |
| Tests coupled to the implementation: private helpers, call order, internal mocks, an expected value that repeats the code | Non-blocking, unless the test cannot fail for the bug it claims to catch |
| Near-duplicate tests, copied cases, large snapshots | Non-blocking |

Map these dispositions to the review's own scale. Cite each finding at `path:line` with
the code hunk it fails to match. Examples of each kind are in [bad-tests.md](bad-tests.md).
