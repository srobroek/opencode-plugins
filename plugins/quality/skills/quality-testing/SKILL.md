---
name: quality-testing
description: "Load before answering how to test code, or planning, writing or fixing tests: doubles, flaky tests, test data, coverage."
---

# Testing strategy

Language-neutral guidance on what to test and how. For a language's test runner,
fixtures, and assertion idioms, also load the `lang-<language>-testing` skill
(`lang-python-testing`, `lang-typescript-testing`, …) when one is listed; if none is,
follow the project's existing tests and test configuration. For the red-green-refactor
loop and evidence rules, the `quality-code-design` skill's `test-first.md` and
`verification.md` references go deeper.

## Workflow

1. Read the existing tests next to the code: runner, layout, helpers, fixtures,
   naming. New tests follow them.
2. List the behaviors that matter: the contract at the public boundary, edge cases,
   error paths, and the bug being fixed. Each becomes a test name before code.
3. Pick the lowest level that can catch each failure (see the levels table).
4. Work test-first where the change allows: write one failing test, watch it fail
   for the expected reason, make it pass with the least code, refactor, repeat.
5. Run the touched tests and the suite the project gates on. Report a test that did
   not run as not run.

## What to test

- Test behavior through the public interface: inputs, outputs, errors, and the side
  effects callers rely on. A test should survive a refactor that keeps behavior.
- Do not test private helpers, call order, or internal data layout. If a private
  part needs its own tests, it is probably a module that wants extracting.
- Derive the expected value independently (from the spec, a worked example, or a
  simpler oracle), never by copying the implementation's logic or output.
- Cover boundaries: empty, one, many; zero, negative, max; missing, malformed,
  duplicate; the first and last element; time zones and DST where dates matter.
- A bug fix starts with a test that reproduces the bug.

## Levels and when each pays off

| Level | Exercises | Pays off for | Cost |
| --- | --- | --- | --- |
| Unit | One function or module, in process, no I/O | Domain rules, parsers, calculations, state machines | Milliseconds; break on interface changes only |
| Integration | Your code with a real dependency: database, filesystem, HTTP server, queue | Queries, transactions, serialization, adapter error mapping | Seconds; need setup and isolation |
| End-to-end | The deployed or fully assembled system through its real entry point | A few critical user journeys and wiring | Slow and flakier; keep the set small |

Most tests are unit tests over logic kept free of I/O. Push logic out of adapters so
it can be unit tested, then give each adapter a few integration tests against the
real thing (a real in-memory or container database with real migrations, a temp
directory, a local HTTP server). Do not fix a ratio; choose per risk.

## Test doubles

- Prefer the real implementation when it is fast and deterministic.
- Use a fake (a working in-memory implementation) for a slow or external dependency
  you own an interface to. Run the same contract test suite against the fake and the
  real implementation so the fake cannot drift.
- Use a stub to force a hard-to-reach condition: a timeout, a 500, a full disk.
- Use a mock (asserting calls) only when the call itself is the behavior, such as
  "sends exactly one email". Asserting every interaction couples tests to the
  implementation.
- Mock only at boundaries you own; wrap a third-party client in a thin adapter and
  double the adapter, not the library.

## Flaky tests

A test that sometimes fails is a bug in the test or the code, not noise.

1. Reproduce: run it in a loop, in random order, and in parallel until it fails.
2. Find the source: shared state between tests, real time or sleeps, unseeded
   randomness, unordered collections, network, port or file collisions, races.
3. Fix the cause: inject a clock, seed randomness and print the seed, await the
   condition instead of sleeping, give each test its own temp directory and port.
4. If it cannot be fixed now, quarantine it in a tracked issue. Never add a blanket
   retry that hides it.

## Test data

- Build test data with builders or factory functions that fill valid defaults, so
  each test states only the fields it is about: `anOrder({ total: 0 })`.
- Keep fixtures small and next to the test that uses them. One giant shared fixture
  file couples every test to every field.
- Use fixed, readable values over random ones unless the test is property-based.
- Golden or snapshot files suit large, stable outputs (rendered text, generated
  code). Review every snapshot diff; never update snapshots blindly.

## Property-based testing

Use it for invariants that hold over many inputs: round-trips (`parse(print(x)) == x`),
idempotence, ordering, conservation (totals unchanged by a transfer), and
"never crashes on any input" for parsers of untrusted data. Keep a failing seed
or shrunk example as a regular regression test. Fuzz parsers and decoders that read
untrusted formats.

## Coverage

Coverage shows what no test runs; it does not show that what runs is checked. Read
uncovered lines for missing behaviors, not as a number to raise. Never add
assertion-free tests or exclude code to hit a target. Mutation testing, where
available, is the better signal that tests detect wrong behavior.
