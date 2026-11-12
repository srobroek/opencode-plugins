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

With the helper tool, pass the command and the report path to `quality_test_repeat`:
`runs` 5 for the baseline, 20 for a suspected flaky test. Without it, run the command in
a loop and keep each report under a distinct name.

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
