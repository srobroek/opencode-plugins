# Good tests

Read when you write a test or judge whether a test is worth keeping. Language idioms are
in the `lang-<language>-testing` skill's `references/practice.md`.

## One behavior through the public interface

- Name the test after the behavior: the condition, the action and the outcome, such as
  `rejects an expired token` or `test_total_is_zero_for_empty_cart`. Follow the naming
  style of the suite.
- Arrange, act, assert (or given, when, then), in that order. Each test has one act.
- Call the interface that callers use. The unit under test includes the classes and
  functions behind that interface. "Public" means the contract its callers rely on, not
  every exported symbol.
- Check the result through that interface. When the code under test has a read
  operation, use it instead of reading the database row, file or private field that the
  write touched. An integration test whose subject is the store itself reads the store.
- One logical assertion: several checks are correct when together they state one
  outcome, such as both balances after a transfer. Two unrelated outcomes are two tests.
- A test that still passes when the code under test returns a wrong value protects
  nothing. Delete it or make it assert the outcome.

## Expected values

- Work the expected value out from the requirement, a worked example or a simpler
  oracle.
- Never copy the implementation's computation into the test, and never paste the
  current output in as the expected value. Both repeat the bug that the test must catch.
- Write expected values as literals in the test body, so the reader sees the claim.

## Deterministic and isolated

- A test gives the same result on every run, in any order and in parallel. Do not use
  the real clock, unseeded randomness, the network or state that another test changes.
- Each test creates what it needs and leaves nothing behind: its own temp directory,
  port and records.
- Isolation does not mean a mock for every collaborator. Use the real collaborator when
  it is fast and deterministic ([doubles.md](doubles.md)).

## Readable over deduplicated

Keep tests descriptive and meaningful (DAMP) rather than as short as possible (DRY). A
reader sees the relevant inputs, the action and the expected outcome in the test body
without opening a helper. Share what does not change the outcome; keep in view what
does.

| Share | Keep in the test body |
| --- | --- |
| Builders and factories with valid defaults, so a call names only the fields the test is about: `anOrder({ total: 0 })` | The action under test |
| Resource lifecycle: temp directories, servers, database setup with cleanup | The inputs that the outcome depends on |
| Small fakes that pass a contract test | The expected values |
| Domain assertions that give a clearer failure message | The case list of a parametrized test, with readable case ids |

A test has no branches or loops that decide what to assert. Parametrize instead.

## Test data and snapshots

- Keep fixtures small and next to the tests that use them. Move a fixture to shared
  setup only when a second test file needs it. A large shared fixture couples every test
  to every field.
- Use fixed, readable values. Random values belong in property-based tests, with the
  seed printed.
- Snapshot or golden files suit small, stable, public output such as rendered text or
  generated code. Normalize timestamps, ids and ordering first. Review every snapshot
  diff as an assertion change, and never update snapshots in CI.
- Do not snapshot a whole object graph or a value that a plain equality check states
  more clearly.

## Test smells

Treat a smell as a reason to look again, not as an automatic rejection. Each smell has
a code example and a fix in [bad-tests.md](bad-tests.md).

| Smell | Sign | Fix |
| --- | --- | --- |
| Mystery guest | The outcome depends on a file, row or environment variable that the test does not show | Create it in the test, or name it in the builder call |
| General fixture | Every test builds one large shared setup and uses a small part of it | Per-test builders with defaults |
| Obscure test | The reader cannot tell what is checked without opening helpers | Put the action and the expected values in the test body |
| Assertion roulette | Many unrelated assertions; a failure does not say which behavior broke | One test per behavior, or a message on each assertion |
| Conditional logic | `if`, loops or exception handlers decide what the test asserts | Parametrize, with one path per case |
| Sleepy test | The test waits a fixed time for something to happen | Await the condition, or inject or fake the clock |
| Empty test | The test runs code and asserts nothing, or only that nothing was thrown when throwing is not the risk | Assert the outcome, or delete the test |
| Eager test | One test exercises several behaviors | One test per behavior |
| Duplicate | The same check twice in one test, or the same scenario in two tests | Keep one |

Sources: [Software Engineering at Google, ch. 12](https://abseil.io/resources/swe-book/html/ch12.html),
[The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html),
[xUnit Test Patterns: test smells](http://xunitpatterns.com/Test%20Smells.html),
[tsDetect smell catalog](https://testsmells.org/pages/testsmellexamples.html),
[Canon TDD](https://newsletter.kentbeck.com/p/canon-tdd).
