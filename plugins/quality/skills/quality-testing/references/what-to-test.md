# What to test, and at which level

Read when you choose a test level, or decide whether something needs a test at all.

## Levels

| Level | Exercises | Pays off for | Cost |
| --- | --- | --- | --- |
| Unit | One function or module, in process, no I/O | Domain rules, parsers, calculations, state machines | Milliseconds; breaks on interface changes only |
| Integration | Your code with a real dependency: database, filesystem, HTTP server, queue | Queries, transactions, serialization, framework configuration, adapter error mapping | Seconds; needs setup and isolation |
| End-to-end | The deployed or fully assembled system through its real entry point | A few critical user journeys and wiring | Slow and less reliable; keep the set small |

- Choose the smallest scope that can detect the fault. Pure policy belongs in unit tests.
  SQL semantics, serialization, framework wiring and transport contracts need an
  integration test against the real thing.
- Push logic out of adapters so that unit tests reach it. Give each adapter a few
  integration tests: a real in-memory or container database with real migrations, a temp
  directory, a local HTTP server.
- Do not fix a ratio between levels. The pyramid, the trophy and the honeycomb describe
  particular architectures. Weigh speed, maintainability, resource use, reliability and
  fidelity for each risk.
- Test one scenario at one level. Add a test at a second level only for a separate risk,
  such as the wiring of a unit-tested rule into a handler, and do not repeat the cases
  there.

## What to cover

- The contract at the public boundary: inputs, outputs, errors, and the side effects that
  callers rely on, such as a sent message or a written record.
- Size boundaries: empty, one, many. Number boundaries: zero, negative, maximum.
- Input boundaries: missing, malformed, duplicate, the first and the last element.
- Time zones and daylight saving time, where dates matter.
- The error paths that callers handle.
- The bug being fixed ([maintenance.md](maintenance.md)).

## What not to test

| Do not test | Reason | Test instead, when it matters |
| --- | --- | --- |
| Getters, setters and constructors that only assign | No logic to break | The behavior that uses them |
| Private helpers, directly | A refactor breaks the test while behavior stays the same | The public behavior. A private part that needs its own tests is a module to extract |
| Call order and internal data layout | The test fails on harmless refactors | The outcome |
| Framework, library and generated code | Its authors test it | Your configuration of it, in an integration test |
| A constant or configuration value restated in the test | The test repeats the source and fails only when someone edits both | The behavior that the value drives |
| What the compiler or type checker proves: types, required fields, interface conformance | The build already fails | Runtime validation of untrusted input |
| That a function, export, module or file exists, or that it is gone | This checks structure, not behavior | A packaging or compatibility check at a public API boundary. For a capability that must stay off, the forbidden outcome, such as a 404 from a removed endpoint |
| Diagnostic log lines | The wording changes freely | For audit or security logs that are requirements: the record, not its format |
| The implementation's own computation as the expected value | The test passes with the same bug | An expected value worked out independently |

Packaging and API compatibility, audit logging, security exclusions and protocol
constants can be requirements. Then test the contract at the boundary where callers
observe it.

Sources: [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html),
[SMURF: beyond the test pyramid](https://testing.googleblog.com/2024/10/smurf-beyond-test-pyramid.html),
[Software Engineering at Google, ch. 12 and 14](https://abseil.io/resources/swe-book/html/ch12.html),
[Change-detector tests considered harmful](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html),
[Khorikov: structural inspection](https://enterprisecraftsmanship.com/posts/structural-inspection/).
