# Candidate catalog

Read in step 3 of the audit. Each class names its signal, the evidence that confirms it,
and the default action. A signal makes a test a candidate; only the evidence makes it a
finding. Examples of most classes are in the `quality-testing` skill's
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

## Keep

Keep a test, even when it looks redundant, when it is the only test that kills a mutant,
when it is a contract test that a fake or a consumer relies on, or when it guards a
requirement such as an audit log, a security exclusion or a public API. Record why.
