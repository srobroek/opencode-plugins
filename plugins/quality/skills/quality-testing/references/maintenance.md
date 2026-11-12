# Maintaining tests with the code

Read when you change, remove or refactor tested code, fix a bug, change legacy code
without tests, or meet a flaky test.

## Tests change in the same change as the code

| Change | Tests |
| --- | --- |
| Refactor that keeps behavior | No assertion changes. Mechanical edits, such as a renamed import or a moved file, are correct. A changed assertion means the behavior changed, or the test was coupled to structure |
| New behavior | New tests for each behavior on the list |
| Bug fix | One regression test that fails without the fix |
| Changed requirement | Update the affected expected values. The commit or pull request names the requirement |
| Removed behavior | Delete its tests, fixtures, builders, fakes, snapshots and test data |

Put test changes in the same commit or pull request as the behavior change. A later
"add tests" change leaves a window in which nothing protects the behavior.

## Removing code

- Delete the tests of removed behavior. Do not comment them out, skip them or mark them
  as expected failures.
- Delete the fixtures, helpers, fakes, snapshots and golden files that only the deleted
  tests used.
- Do not add a test that checks that a function, module, export, flag or file is gone:
  an import that fails, a missing attribute, an empty reflection lookup, a compile-fail
  test. The build and the deleted call sites prove the removal.
- When the removal is itself a requirement, such as an endpoint that must stay off or a
  permission that must stay denied, test the observable outcome at the boundary.
- When behavior moves behind a deeper interface, port the edge cases to tests of the new
  interface, then delete the old tests. Do not keep both layers (the `quality-code-design`
  skill's `deep-modules.md` reference).

## Bug fixes

- Reproduce the bug first: one test at the lowest level that reaches the real trigger.
  It fails before the fix for the reported reason, and passes after it.
- Add a test at a second level only for a separate risk, such as the wiring between
  callers.
- For hard bugs, follow the `quality-code-design` skill's `debugging.md` reference.

## Legacy code without tests

Before you change untested code, write characterization tests at the seam you are about
to change. They record what the code does now, not what it should do: name them so,
such as `characterizes rounding of negative totals`. Cover only the area of the change.
When the contract is known, replace them with behavior tests.

## Flaky tests

A test that sometimes fails is a bug in the test or in the code.

1. Reproduce it: run it in a loop, in random order and in parallel until it fails.
2. Find the source: state shared between tests, the real clock or sleeps, unseeded
   randomness, unordered collections, the network, port or file collisions, races.
3. Fix the cause: inject a clock, seed randomness and print the seed, await the
   condition instead of sleeping, give each test its own temp directory and port.
4. When it cannot be fixed now, quarantine it: a tracked issue with an owner and an
   expiry date, and a separate lane that keeps running it without blocking merges. At
   expiry, fix it or delete it.

Keep retries off by default. A retry that turns a failure green hides the flake unless
the runner still records it as flaky.

## Where tests live and run

- Keep tests next to the code they test, or in the layout that the language and the
  project use.
- Select affected tests for quick local runs, and run the full suite in CI. Selection by
  file name alone misses tests that depend on the changed code.

Sources: [Software Engineering at Google, ch. 11 and 12](https://abseil.io/resources/swe-book/html/ch12.html),
[Characterization testing](https://michaelfeathers.silvrback.com/characterization-testing),
[Khorikov: structural inspection](https://enterprisecraftsmanship.com/posts/structural-inspection/).
