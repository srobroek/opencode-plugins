# Evidence commands

Read in step 2 of the audit. Commands checked against official documentation on
2026-11-12; "not verified" marks a capability that was not confirmed, so do not rely on
it. Choose your own output paths in the OpenCode temp directory: most tools have no
default report file.

## Repeated runs in random order, with JUnit output

| Runner | JUnit report | Random order, and replay of a seed |
| --- | --- | --- |
| pytest | `pytest --junitxml=<path>` | `pytest -p randomly`; replay with `--randomly-seed=<seed>` (`pytest-randomly`) |
| Vitest | `vitest run --reporter=junit --outputFile=<path>` | `--sequence.shuffle`; replay with `--sequence.seed=<seed>` |
| bun test | `bun test --reporter=junit --reporter-outfile=<path>` | `--randomize`; replay with `--seed <seed>` |
| Go | `gotestsum --junitfile <path> -- ./pkg/...` (`go test` has no JUnit flag) | `go test -shuffle=on`; replay with `-shuffle=<seed>`; add `-count=1` to skip cached results |
| Rust | `cargo nextest run --profile <name>` with `[profile.<name>.junit] path = "junit.xml"` in `.config/nextest.toml`; the report lands in `target/nextest/<name>/junit.xml` | nextest shuffle not verified. `cargo +nightly test -- -Z unstable-options --shuffle` and `--shuffle-seed <seed>` exist on nightly only |

File order and test order within a file are two different shuffles, and they catch
different order dependences: a dependence between two tests in one file passed every
file-order shuffle in a real audit. Run both, plus a default-order run, and pass a mode
per run to `quality_test_summarize` (`default`, `shuffle-files`, `shuffle-tests`).

| Runner | Shuffle file order | Shuffle tests within a file |
| --- | --- | --- |
| Vitest | `--sequence.shuffle.files` (root config only; checked 2026-11-15 against the 5.0 docs) | `--sequence.shuffle.tests` (per project). `--sequence.shuffle` turns on both |
| pytest | Not verified: `pytest-randomly` shuffles modules, classes and functions together; check its documentation for a separate switch | Same as the left cell |
| bun test | Not verified | `--randomize` (documented as shuffling test order; whether it also shuffles files was not verified) |
| Go | Not verified for package order | `go test -shuffle=on` shuffles tests and benchmarks of a package |
| Rust | Not verified | Nightly `--shuffle` only |

Run the command through the shell for the baseline: 3 default-order runs, 3 with file
order shuffled and 3 with test order shuffled (20 runs of the suspected mode for a flaky
test), with one report per run in the OpenCode temp directory, for example
`for i in 1 2 3; do vitest run --reporter=junit --outputFile=<dir>/default-$i.xml; done`, then
the same loop with `--sequence.shuffle.files` into `<dir>/files-$i.xml` and with
`--sequence.shuffle.tests` into `<dir>/tests-$i.xml`. Then call `quality_test_summarize` with
`reports` (the paths in run order), `modes` (`default`, `shuffle-files` or `shuffle-tests` for
each report, same length) and `exitCodes` (what each run returned, if you kept them). The
summary calls a test order-dependent only when it passed in a default run and failed in a
shuffled one; a shuffled failure without a default-order pass is inconclusive. A test that failed in
every default run but passed a shuffled run is listed on its own; when a default run skipped
it or lacked it, it is inconclusive too. A `findings:` line opens the output with the count
of each category. Without the tool,
keep each report under a distinct name and read them.

The tool also reports, per run, the report size in bytes, the number of lines in
`system-err` elements (a run above 1000 lines or 5 MB is flagged noisy; `noisyStderrLines` and `noisyFileBytes` change the limits) and the summed
test duration, and for each failing test how many failures were timeouts and how many
assertions or errors. The timeout class is a heuristic: the failure message or type
matches "timeout", "timed out" or "time-out".

## Timing and machine load

Wall time on a shared or busy machine is noise. For each timed comparison record:

- the machine load before and after (`uptime`, or the CI runner's load) and what else
  was running;
- the summed test duration (the tool's per-run figure) beside wall time;
- user CPU time, for example from `time <cmd>` (`user`) or `/usr/bin/time -v`.

Reproduce a suspected timing flake twice: idle, and under deliberate load. Load comes
from busy loops (one per core, for example `yes > /dev/null &` per core) or from running
the suite in parallel workers. A flake that failed 0 of 80 idle runs failed 19 of 60 with
the CPU saturated in a real audit. Label each flake load-related (only fails under load)
or order-related (fails in shuffled runs with idle CPU).

## Coverage

| Runner | Command | Branches |
| --- | --- | --- |
| pytest | `pytest --cov=<pkg> --cov-branch --cov-report=lcov:<path>` (or `xml:<path>` for Cobertura) | Yes, with `--cov-branch` |
| Vitest | `vitest run --coverage --coverage.reporter=lcov`; reports go to `./coverage` | Yes, with the `v8` and `istanbul` providers |
| bun test | `bun test --coverage --coverage-reporter=lcov`; writes `coverage/lcov.info` | Not documented: lines and functions only |
| Go | `go test -coverprofile=<path> ./...` writes the Go cover profile | No: statement blocks only |
| Rust | `cargo llvm-cov nextest --lcov --output-path <path>` | Nightly only; the flag spelling was not verified |

Per-test coverage exists for pytest: `pytest --cov=<pkg> --cov-context=test
--cov-report=html` with `show_contexts = True` in the `[html]` section of the coverage
configuration shows which tests cover each line. No native equivalent was verified for
Vitest, bun test, Go or Rust; Stryker maps tests to mutants instead.

## Mutation testing

| Language | Command scoped to the audit | Report for `quality_test_compare` |
| --- | --- | --- |
| Python | `mutmut run "<module>.<function>*"`; scope with `[tool.mutmut]` `source_paths` and `only_mutate` | No per-mutant JSON export: `mutmut export-cicd-stats` writes summary counts only. Compare `mutmut results` by hand |
| TypeScript | `npx stryker run --testRunner vitest --mutate "<file>" --reporters json` | `reports/mutation/mutation.json` (mutation-testing-report-schema) |
| Go | `gremlins unleash --diff "<base-ref>" --output=<path>` | The JSON file named by `--output` |
| Rust | `cargo mutants --file '<file>'` or `cargo mutants --in-diff <diff-file>` | `mutants.out/outcomes.json`, or the directory named by `--output` |

When mutation testing cannot run on a scope (a runner pool requirement, a bundler step
that breaks the mutation tool, a scope too slow), use hand-made forced faults as the
evidence. Steps 1 to 5 of the audit change nothing in the repository, so make the faults in
a disposable copy outside it: export the commit into the OpenCode temp directory (for
example `git archive HEAD | tar -x -C <dir>/faults`), install the dependencies there, change
the code so the behavior is wrong, and confirm the named test fails. Delete the copy when
done. Record each fault and its result, and say in the report that the evidence is manual.

Run the same command for the baseline and after each batch. Stryker's `--incremental`
reuses earlier results: run without it for the final comparison.

## Unused assets

| Asset | Command |
| --- | --- |
| syrupy snapshots | `pytest --snapshot-details` lists unused snapshots; `pytest --snapshot-update` deletes them |
| Vitest snapshots | Obsolete snapshots fail CI by default; `vitest run -u` removes them |
| bun test snapshots | `bun test --update-snapshots` removes unused entries |
| insta snapshots | `cargo insta test --unreferenced=reject` lists them; `--unreferenced=delete` deletes them |
| pytest fixtures | `pytest --dead-fixtures` (`pytest-deadfixtures` 4) lists unused fixtures; compatibility with pytest 9 was not tested |
| Go and TypeScript fixtures, test data files | No tool was verified: search for each name and path |

Delete unused snapshots only through the runner's own command, in an approved batch.

## Listing tests and timing them

| Runner | List without running | Slowest tests |
| --- | --- | --- |
| pytest | `pytest --collect-only -q` | `pytest --durations=10 --durations-min=1.0` |
| Vitest | `vitest list` | The JUnit report, or `--reporter=verbose` |
| bun test | Not verified | The JUnit report |
| Go | `go test -list . ./...` (top-level tests only) | `gotestsum --jsonfile <path>`, then `gotestsum tool slowest --jsonfile <path> --threshold 500ms` |
| Rust | `cargo nextest list` | The JUnit report |
