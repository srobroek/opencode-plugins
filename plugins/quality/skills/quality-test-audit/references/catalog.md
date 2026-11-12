# Candidate catalog

Read in step 3 of the audit. Each class names its signal, the evidence that confirms it,
and the default action. A signal makes a test or a gap a candidate; only the evidence
makes it a finding. The groups are Prune, Purge, Fix, Speed up, Simplify, Strengthen and
Keep, then the suite-level practices. Examples of most classes are in the `quality-testing` skill's
`references/bad-tests.md`.

## Prune: tests that add no protection

| Class | Signal | Evidence that confirms it | Default action |
| --- | --- | --- | --- |
| Duplicate | Two tests with the same setup, action and assertion shape, or the same scenario at two levels | Every mutant that the test kills is also killed by another test, and the scenario has no separate risk | Delete, or merge into one parametrized test |
| Copied cases | Tests that differ only in literals | The same shape in each test | Merge into one parametrized test with readable case names |
| Removal check | Asserts that a function, export, module, attribute or file is missing | The assertion reads the module's structure; no caller-visible outcome is checked | Delete. When the removal is a requirement, replace it with a test of the forbidden outcome |
| Obsolete | Tests a behavior that the code no longer has, or tests through a deleted path that a shim keeps alive | The behavior is gone from the spec or the code; no caller uses it | Delete with its fixtures and data |
| Never fails | Runs code but would pass if the code returned a wrong value | The test kills no mutant in the code it covers, or survives a forced red | Make it assert the outcome, or delete it |
| Assertion-free | No assertion, or only "does not throw" where throwing is not the risk | Read the test | Assert the outcome, or delete it |
| Trivial | Getters, setters, constants, or what the type checker proves | Read the test; the build fails without the code anyway | Delete |

## Purge: test assets that nothing uses

| Class | Signal | Evidence that confirms it | Default action |
| --- | --- | --- | --- |
| Unused snapshot | A snapshot or golden file that no test reads | The runner's obsolete or unreferenced snapshot report | Delete through the runner's own command |
| Unused fixture or builder | A fixture, factory, fake or helper with no caller | Search and the runner's fixture listing show no use | Delete |
| Orphan test data | Files under `testdata/`, `fixtures/` or similar that no test opens | Search for each file name and path | Delete |
| Dead quarantine | A skipped or quarantined test past its expiry, or with no issue | The skip marker, its date and its issue | Fix it or delete it, and close the issue |

## Fix: tests that protect behavior badly

| Class | Signal | Evidence that confirms it | Default action |
| --- | --- | --- | --- |
| Flaky | Passes and fails across repeated runs | Mixed outcomes in the repeat report | Fix the cause (the `quality-testing` skill's `maintenance.md`), or quarantine |
| Coupled to the implementation | Tests private helpers, call order, or mocks of the module's own collaborators | The test breaks on a refactor that keeps behavior, or it asserts calls instead of outcomes | Rewrite through the public interface with real objects or a fake |
| Copied expected value | The expected value repeats the implementation's computation | Read the test | Replace it with a value from the requirement or a worked example |
| Checks around the interface | Reads a table, file or private field although a read operation exists | Read the test | Check through the read operation |
| Logic in the test | `if`, loops or exception handlers decide what to assert | Read the test | Parametrize with explicit cases |
| Eager | One test checks several behaviors | Several acts, or unrelated assertions | Split into one test per behavior |
| Oversized snapshot | A snapshot of a whole object or a long output | Its size, and updates accepted without review in the history | Assert the part that the behavior is about |

## Speed up

| Class | Signal | Evidence that confirms it | Default action |
| --- | --- | --- | --- |
| Slow | Among the slowest tests by median time | The repeat report's slowest list | Find the cost: real I/O, sleeps, broad fixtures, a high level |
| Sleepy | Waits a fixed time | A sleep call in the test or its helpers | Await the condition, or fake the clock |
| Wrong level | An end-to-end or integration test that checks pure logic | The logic has no I/O dependency | Move the cases to unit tests; keep one wiring test |
| Expensive setup | A fixture rebuilt for each test without need, or a session fixture that leaks state | Fixture scope and durations | Narrow or widen the scope to match what the tests change |

## Simplify: tests that are hard to read or change

| Class | Signal | Evidence that confirms it | Default action |
| --- | --- | --- | --- |
| Mystery guest | The outcome depends on a file, row, environment variable or global fixture the test does not show | Read the test and its fixtures | Build the data in the test, or name it in a builder call |
| General fixture | Many tests share one large setup and each uses a small part of it | Fixture size against the fields each test reads | Per-test builders with valid defaults |
| Obscure test | The action or the expected values sit in helpers, so the test body does not show the claim | Read the test body alone | Inline the action and the expected values; keep only setup in helpers |
| Long arrange | The setup is much longer than the act and the assert | Line counts per section | A builder or factory that states only the fields the test is about |
| Mock-heavy | Mock setup is longer than the test, or mocks return mocks | Read the test | A fake at the boundary, or the real collaborator |
| Over-abstracted helpers | Test helpers with flags, branches or their own tests | Read the helpers and their callers | Split them, or inline them where they hide the behavior |

## Strengthen: behavior that no test protects

| Class | Signal | Evidence that confirms it | Default action |
| --- | --- | --- | --- |
| Surviving mutant | A mutant that changes caller-visible behavior survives | The baseline mutation report, and a reading that the mutant is not equivalent | Extend the test that covers the code with the case that kills it; add a test only when none fits |
| Uncovered public branch | An error path, boundary or branch of public behavior that no test runs | Branch coverage, read against the public contract | Add the case to the matching parametrized test, or add one test at the lowest level that reaches it |
| Bug without a regression test | A fixed bug in the history or the issue tracker whose trigger no test reproduces | The fix commit and the test diff beside it | Add one regression test that fails without the fix |
| Weak assertion | A test asserts less than the behavior promises: not-null, a length, or a substring where a value is known | Read the test against the requirement | Assert the exact outcome |

Skip a branch or mutant in trivial code, in generated code, or in code that the
`quality-testing` skill's `what-to-test.md` says needs no test. Record the skip.

## Keep

Keep a test, even when it looks redundant, when it is the only test that kills a mutant,
when it is a contract test that a fake or a consumer relies on, or when it guards a
requirement such as an audit log, a security exclusion or a public API. Record why.

## Suite practices

Read the suite as a whole and recommend changes in the report. Each recommendation
names the evidence and the place to change. Check:

- **Runner settings:** random order with the seed printed. Retries off, or recorded as
  flaky. A timeout per test, and parallel runs where the tests are isolated.
- **CI lanes:** a fast unit lane on every change, an integration lane, mutation testing
  on changed files, and a flaky-test lane for quarantined tests with their issues.
- **Coverage settings:** branch coverage on; exclusions that hide code nobody decided to
  skip; a coverage target used as a gate.
- **Shared setup:** global or `autouse` fixtures, a large shared fixture file, or a
  builder that hides the fields a test depends on.
- **Conventions:** test names, file layout, and assertion and mocking libraries that
  differ across the suite for no reason.
- **Snapshots:** snapshot files in total, the largest ones, and how often they are
  updated in bulk.
- **Tooling gaps:** a missing mutation tool, a missing JUnit reporter, or no
  per-test coverage, with the tool from the language's `practice.md`.
