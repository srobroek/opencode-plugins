# Testing tools

Choose Rust test tools by the failure they reveal. See [Rust testing practice](../../lang-rust-testing/references/practice.md) for idioms, [quality.md](quality.md) for lint, safety and docs checks, and `lang-rust-quality` for commands. The framework is `toolchain-languages`' `concerns.md`: detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers.

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `cargo-nextest` plus `cargo test --doc` | >= 0.9 · 2026-11-13 · active | `cargo nextest --version` · `cargo binstall cargo-nextest` | `cargo test`: nextest cannot be installed | Always: nextest skips doctests | every-pr | Assuming process isolation covers shared files, ports or databases, or replaces doctests |
| `assertions` | Built-in: `assert!`, `assert_eq!`, `matches!` plus `pretty_assertions` as the diff helper | >= 1.4.1 · 2024-09-15 · maintenance | `grep -rlE --include=Cargo.toml --exclude-dir=target '^pretty_assertions\b' .` · `cargo add --dev pretty_assertions` | similar-asserts: large strings (2.0.0); googletest: pre-1.0 (0.14.4), composable matchers and non-fatal `expect_that!` | - | every-pr | `assert_matches` crate (use std `matches!`); `k9` (stale) |
| `watch` | `bacon` with its nextest job | >= 3.26.0 · 2026-09-26 · active | `bacon --version` · `cargo binstall bacon` | watchexec 2.8.0: language-agnostic watching | nextest filtersets for selection: `-E 'package(x)'` | on-demand | `cargo-watch` (archived); bacon is AGPL-3.0, which is fine for running the CLI |
| `property` | `proptest` | >= 1.12 · 2026-10-10 · active | `grep -rlE --include=Cargo.toml --exclude-dir=target '^proptest\b' .` · `cargo add --dev proptest` | `quickcheck`: simple `Arbitrary` generators; `bolero`: one target shared by property and fuzz engines; `hegeltest`: early, watch only | `proptest` and `bolero` when a property target also feeds a fuzz engine | on-demand | Losing shrunk failures or seeds; generating only valid inputs for parsers; adding all engines |
| `fuzz` | `cargo-fuzz` | >= 0.13 · 2026-06-09 · active | `cargo fuzz --version` · `cargo install --locked cargo-fuzz` | `bolero`: unified property and fuzz targets; `afl.rs`: AFL-family engine needed; `LibAFL`: custom fuzzer | `cargo-fuzz` and `bolero` when targets are shared | bounded-pr | Discarding corpora or crash inputs; unbounded PR campaigns; a no-panic target as the only oracle |
| `fuzz-continuous` | Shared: clusterfuzzlite | - | Shared | `Shared: oss-fuzz`: a public open-source project | - | scheduled | Running long campaigns on the PR path; dropping the corpus between runs |
| `mutation` | `cargo-mutants` under its default `cargo test` | >= 27.1 · 2026-06-02 · active | `cargo mutants --version` · `cargo binstall cargo-mutants` | None | - | diff-pr + scheduled | Whole-project mutation as an unconditional PR gate; test-only diffs assumed to select mutants; nextest runs that hide doctest-only coverage |
| `snapshot` | `insta` | >= 1.49 · 2026-10-03 · active | `cargo insta --version` · `cargo binstall cargo-insta` | Direct semantic assertions: small outputs | - | every-pr | Automatic acceptance in CI; unstable IDs or times in snapshots |
| `component` | N/A: no UI component model | - | - | None | - | every-pr | - |
| `concurrency` | `loom` | >= 0.7 · 2026-11-08 · active | `grep -rlE --include=Cargo.toml --exclude-dir=target '^loom\b' .` · `cargo add --dev loom` | `shuttle`: randomized exploration of larger models; ThreadSanitizer: real code on nightly with `-Zbuild-std` | `loom` for small primitives and TSan for the real binary | on-demand | Treating bounded exploration or stress tests as proof of race freedom |
| `coverage` | `cargo-llvm-cov` with `cargo llvm-cov nextest` | >= 0.9 · 2026-09-06 · active | `cargo llvm-cov --version` · `cargo binstall cargo-llvm-cov` | `cargo-tarpaulin`: Linux-only projects that already use it | - | every-pr | A percentage as correctness proof; assuming branch or doctest coverage is included |
| `benchmark` | `criterion` | >= 0.8 · 2026-02-04 · active | `grep -rlE --include=Cargo.toml --exclude-dir=target '^criterion\b' .` · `cargo add --dev criterion` | `divan`: ergonomic allocation-aware benchmarks; `gungraun`: Valgrind instruction counts for noisy CI (unverified, early) | `criterion` for wall time and `gungraun` for stable CI counts | on-demand | Microbenchmarks without a representative workload; unpinned machines |
| `flaky-order` | `cargo-nextest` retries and `--stress-count` | >= 0.9 · 2026-11-13 · active | `cargo nextest --version` · `cargo binstall cargo-nextest` | nightly shuffle: `cargo +nightly test -- -Z unstable-options --shuffle` for order-dependence hunting, because nextest has no shuffle | Both: nextest for repeats, nightly shuffle for order | scheduled | Retries on by default; reporting an eventual pass as clean; quarantine with no owner or expiry |
| `integration` | Shared: testcontainers | - | Shared | Existing isolated provisioned test infrastructure: it already exists | - | on-demand | Mocking away transaction and constraint semantics; assuming Docker exists in CI |
| `contract` | Shared: contracts | - | Shared | pact_consumer and pact_verifier 1.6.0: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr + scheduled | Pact as the only gate for public APIs; mocks mistaken for provider compatibility evidence |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | on-demand | Archived Dredd for new OpenAPI adoption |
| `load` | Shared: k6 | - | Shared | `oha`: simple HTTP load from one command; `goose`: Rust-coded scenarios | `k6` for scenarios and `oha` for quick checks | scheduled | Production load without authorization; framework benchmark rankings as app evidence |

## Tradeoffs

### property

- **proptest**: wins when strategies, shrinking and saved regression seeds matter; costs a heavier API than `quickcheck`.
- **quickcheck**: wins for simple `Arbitrary` generators; costs weaker shrinking and no persistence.
- **bolero**: wins when one target must serve property tests and fuzz engines; costs a younger ecosystem.
- **hegeltest**: wins on promise only, because it is early; costs stability, so watch it and do not adopt it.

### assertions

- **pretty_assertions**: wins for readable diffs of compound values; costs a dependency that shadows `assert_eq!`.
- **similar-asserts**: wins for large strings; costs a second diff crate.
- **googletest**: wins for composable matchers and non-fatal checks; costs a pre-1.0 API.

### fuzz

- **cargo-fuzz**: wins as the standard libFuzzer workflow with corpus tooling; costs nightly and no Windows MSVC support.
- **bolero**: wins when fuzz and property targets are shared; costs a second API to learn.
- **afl.rs**: wins when infrastructure needs an AFL-family engine; costs a build step per target.
- **LibAFL**: wins for custom engines and harnesses; costs setup and maintenance of your own fuzzer.

### fuzz-continuous

- **clusterfuzzlite**: wins for a project without OSS-Fuzz access, run from CI; costs your own CI minutes and corpus storage.
- **oss-fuzz**: wins for a qualifying public project, with managed infrastructure; costs an application and a maintained project.

### concurrency

- **loom**: wins for exhaustive exploration of small lock-free or sync primitives; costs instrumented types and a state-space limit.
- **shuttle**: wins for larger models, with randomized schedules and replayable seeds; costs exhaustiveness.
- **ThreadSanitizer**: wins on real code and FFI-free binaries; costs nightly, `-Zbuild-std` and only the interleavings that occurred.

### benchmark

- **criterion**: wins on statistics and regression reports for wall time; costs noise on shared CI runners.
- **divan**: wins on ergonomics and allocation counts; costs the last release in 2025.
- **gungraun**: wins when Valgrind instruction counts give stable CI numbers; costs Valgrind (Linux) and an unverified project lineage.

### flaky-order

- **nextest retries**: wins on marking flaky tests and repeating with `--stress-count`; costs no order shuffling.
- **nightly shuffle**: wins at exposing order dependence with a replayable `--shuffle-seed`; costs a nightly toolchain and plain `cargo test`.

### load

- **k6**: wins for scripted scenarios and thresholds; costs JavaScript scripts outside the Rust build.
- **oha**: wins as a one-command HTTP load check; costs scenarios and thresholds.
- **goose**: wins when scenarios belong in Rust; costs a separate binary crate and a smaller community.

## Language-specific

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Async | `tokio` test facilities (`#[tokio::test]`, paused time) | Sync test for pure logic | Real sleeps and arbitrary delays; unjoined tasks. |
| Parameterization | `rstest` | Ordinary table loops for simple cases | Fixture frameworks for one value. |
| Trait doubles | Real implementations or handwritten fakes at owned boundaries | `mockall` when boundary interactions are contractual | Mocking internal call order or third-party types throughout business code. |
| HTTP mocking | `wiremock` | `httpmock` for its API | Mocks mistaken for provider compatibility evidence. |
| HTTP recording | Reviewed redacted fixtures with `wiremock` | Approved recording tool when a named gap requires it | Unverified recorder recommendation; recording tokens or personal data. |
| Factories | Small Rust builders and functions | `fake` for seeded broad fixture generation | Random default data making failures irreproducible. |
| Integration crate | `testcontainers` crate for the shared testcontainers row | Existing isolated provisioned infrastructure | Pinless images; no readiness checks. |
| Test diagnostics | `test-log` | `serial_test` only for unavoidable shared state | Serializing tests instead of isolating resources. |

## Rules

- Test pure logic directly and adapters against real semantics. Keep contracts for fakes and real implementations aligned.
- Preserve failing seeds and corpora, isolate ports, databases and files, inject clocks, and await conditions. Review snapshot changes manually.
- Run benchmarks on pinned configurations. Use telemetry test exporters from `observability.md`, not network backends for ordinary tests.
- Run cargo-mutants under the default `cargo test`, which includes doctests. `--test-tool=nextest` (or `test_tool = "nextest"` in `.cargo/mutants.toml`) skips doctests, so doctest-only coverage shows as missed; use it only where a suite needs process isolation or runs measurably faster, and accept those misses.

- Install in CI with `taiki-e/install-action` for nextest, cargo-mutants, cargo-llvm-cov and cargo-deny where it offers them; cargo-fuzz needs a nightly toolchain; cargo-llvm-cov needs `rustup component add llvm-tools-preview`; the insta library is added with `cargo add --dev insta`.

## Sources

- [Nextest](https://nexte.st/), [Proptest](https://crates.io/crates/proptest), [Insta](https://crates.io/crates/insta), [Wiremock](https://docs.rs/wiremock/latest/wiremock/), [Testcontainers](https://docs.rs/testcontainers/latest/testcontainers/).
- [cargo-mutants](https://mutants.rs/), [cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz), [cargo-llvm-cov](https://crates.io/crates/cargo-llvm-cov), [Crate registry](https://crates.io/).
- [Oha](https://github.com/hatoo/oha), [Loom](https://docs.rs/loom/latest/loom/), [Shuttle](https://docs.rs/shuttle/latest/shuttle/).
