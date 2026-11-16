# Quality signals

Read when you use coverage, mutation testing, property tests or fuzzing to judge or
extend a suite. Pick the tool for each signal from the language's concerns table
(`coverage`, `mutation`, `property`, `fuzz`, `fuzz-continuous` and `flaky-order` rows), found
through the `toolchain-languages` skill's `references/concerns.md`; shared tools and report
formats are in its `references/shared-tools.md`. Detect a tool before use, and recommend
the install command and ask permission before you install it. Idioms are in the
`lang-<language>-testing` skill's `references/practice.md`.

| Signal | Shows | Does not show | Use |
| --- | --- | --- | --- |
| Line and branch coverage | Code that no test runs | That the code that runs is checked | Read uncovered branches for missing behaviors. It is not a number to raise |
| Changed-lines coverage | Lines in this diff that no test runs | Assertion strength | A hint in review, beside full-suite coverage |
| Mutation score | Whether tests fail when the code is changed on purpose | Which surviving mutants matter | Run it on critical logic, or on the diff of a pull request. A surviving mutant that changes behavior gets a test; an equivalent or irrelevant one does not |
| Flaky rate | Whether the suite can be trusted | The cause | Record every retry; fix or quarantine ([maintenance.md](maintenance.md)) |
| Suite runtime | Feedback speed | Value | Keep unit tests at milliseconds each |

- Never add assertion-free tests, or exclude code, to reach a coverage target. Do not
  require 100% of any signal.
- Mutation testing is the stronger signal that tests detect wrong behavior. Coverage
  only finds gaps.

## Run cadence

- Mutation: diff-scoped on every pull request, blocking the merge only on the paths the
  project names as critical and reporting elsewhere, plus a scheduled full run.
- Fuzzing: bounded in time or inputs on every pull request, plus scheduled long campaigns
  that keep and grow the corpus.
- Flaky order: shuffled and repeated runs on a schedule, not on every pull request.

## Property-based tests

Use them for invariants that hold over many inputs: round-trips
(`parse(print(x)) == x`), idempotence, ordering, conservation (a transfer keeps the
total), and "never crashes on any input" for parsers of untrusted data.

- One property replaces many example tests only when its oracle does not repeat the
  implementation.
- Keep named examples for edge cases that the contract names.
- Keep a failing seed or a shrunk example as a regular example test.

## Fuzzing

Fuzz parsers and decoders that read untrusted formats. Bound the fuzz time on pull requests and run long campaigns on a schedule. Keep
each minimized crashing input as a regression input.

Sources: [Software Engineering at Google, ch. 11](https://abseil.io/resources/swe-book/html/ch11.html),
[Are mutants a valid substitute for real faults?](https://doi.org/10.1145/2635868.2635929),
[Long-term effects of mutation testing at Google](https://research.google/pubs/long-term-effects-of-mutation-testing/).
