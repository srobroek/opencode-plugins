# Rust testing practice

Checked 2026-11-12.

Rust layout, assertion idioms, and tool choices for small, behavior-focused suites.
Use `quality-testing` for what to test, the behavior budget, same-change maintenance,
and review rules; follow existing repository conventions before adding dependencies.

## Layout and naming

Do keep local tests in `#[cfg(test)] mod tests`, usually with `use super::*`.
Child modules can access private items; that access is not a reason to test every helper.
Use `tests/` for public API integration contracts: each top-level Rust file is its
own integration crate. Put shared support in `tests/common/mod.rs`, imported with
`mod common`, not `tests/common.rs`, which becomes another test crate.
For larger suites, `tests/it/main.rs` with submodules avoids linking many crates.
Name tests for conditions and outcomes, such as `expired_token_is_rejected`.

Do use doc tests for short public API examples. Hidden `# ` lines can supply setup;
`no_run` compiles without executing. Reserve `compile_fail` for genuine API safety
contracts. Do not use `ignore` to conceal a broken example.

## One behavior per test

Do show setup, action, and an independent expected outcome. Several assertions may
describe one outcome; separate unrelated success and error scenarios.
Use `assert_eq!`, `assert!`, and `matches!` with useful failure messages.
Add `pretty_assertions` only when its diffs improve compound or textual failures.

```rust
#[test]
fn expired_token_is_rejected() {
    let token = token_with_expiry(10);
    let result = authenticate(&token, 11);
    assert!(matches!(result, Err(AuthError::Expired)), "{result:?}");
}
```

Do use contextual `expect` for fallible setup, or return a test `Result` and use `?`.
`unwrap` is acceptable for obvious, valid fixtures. Do not chain unexplained
`unwrap` calls or use a panic as the oracle when the contract returns an error.

## Parametrize instead of copying

Do choose `rstest` for named cases and explicit per-test fixtures when repetition
appears. Keep plain `#[test]` for a single case. `test-case` is a lighter alternative
for input/output tables; preserve it if established rather than adding both.

```rust
use rstest::rstest;

#[rstest]
#[case::empty("", 0)]
#[case::one_word("hello", 1)]
#[case::extra_space("hello  world", 2)]
fn counts_words(#[case] input: &str, #[case] expected: usize) {
    assert_eq!(count_words(input), expected);
}
```

Do not generate `#[values]` Cartesian products without distinct risks to cover.
Keep tests separate when setup, action, or the claimed behavior differs; never put
conditional oracle logic in a case table to force unrelated scenarios together.

## Fixtures and builders

Do use small functions or builders with valid defaults and explicit overrides:
`Order { total: 0, ..valid_order() }` exposes the field that matters.
Keep behavior-bearing inputs visible; share resource lifecycle and irrelevant setup.
Put shared integration helpers in `tests/common/mod.rs` and data beside its consumer.
Prefer fresh `rstest` fixtures over `#[once]` fixtures holding mutable state.

Do give each test its own directory, ephemeral port, and database namespace.
Keep resource guards alive for the test and clean up tasks and containers explicitly.
Do not hide network access, environment mutation, or global initialization in setup.

## Doubles

Do use real deterministic implementations first, then small handwritten fakes at
owned dependency boundaries. Share contract checks with the real implementation.
Use `mockall` only at a real boundary when arguments, counts, or order are contractual;
do not create traits for every helper merely to generate mocks.
Avoid expectations that dictate incidental internal call sequences.

Do choose `wiremock` for outbound HTTP adapter tests; `httpmock` is an alternative
when its API or existing use fits. Exercise the actual router for handler contracts.
Neither local server proves compatibility with the provider's actual API.
Use `testcontainers` in an explicit integration run for database/broker semantics,
with pinned images, readiness checks, isolated resources, and a documented container runtime.
Do not make a container the default fixture for pure logic.

## Async, time, and concurrency

Do use `#[tokio::test]` for Tokio code and join spawned work before finishing.
Use channels or completion signals instead of wall-clock sleeps.
Paused time requires Tokio's `test-util` feature and a current-thread runtime:

```rust
#[tokio::test(start_paused = true)]
async fn waiting_expires() {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        std::future::pending::<()>(),
    ).await;
    assert!(result.is_err());
}
```

This illustrates the timing tool; application tests should assert their own timeout
behavior, not re-test Tokio. Paused time does not simulate external I/O or OS threads.
Use `loom` for small synchronization models, or `shuttle` for controlled randomized
schedule exploration and reproducible failures. Both need instrumented primitives.
Do not call bounded exploration or an ordinary stress test proof of race freedom.

## Property tests

Do choose `proptest` for strategies, shrinking, and invariants that replace many
similar examples. Use `prop_assert!` and `prop_assert_eq!` for useful shrunk failures.
Generate domain-valid values for invariants and malformed inputs for rejection paths.
Commit `proptest-regressions` files: saved seeds replay before new generation.
Also keep important minimized failures as readable examples, since strategy changes
can change how a seed is interpreted.

`quickcheck` suits simpler `Arbitrary`-based generators; `bolero` can share generated
input targets between property checks, corpus replay, and fuzz engines.
Do not add all three or assume they shrink and discover inputs identically.

## Snapshots

Do use `insta` for small, stable text or serialized outputs whose diffs are reviewable.
Prefer semantic assertions when they state the contract more clearly.
Inline snapshots keep tiny expectations near the action:

```rust
insta::assert_snapshot!(render_usage(), @"Usage: app <file>");
```

Use redactions for nondeterministic IDs or times, never for fields under test.
Review every update with `cargo insta review`, including inline changes; commit
accepted snapshots and remove obsolete ones with the behavior they described.
Do not auto-accept snapshots in CI or snapshot opaque, enormous object graphs.

## Fuzzing, mutation, and coverage

Do use `cargo-fuzz` for coverage-guided parser/security targets; choose `afl` when
the infrastructure needs an AFL-family engine, or `bolero` for shared property/fuzz
targets. Bound campaigns and retain minimized crash inputs and corpus regressions.
Do not treat a no-panic target as a complete semantic oracle.

Use `cargo-mutants --in-diff change.diff` for important changed logic and periodic
broader runs. A test-only diff may select no mutants; inspect surviving mutants
before adding tests, since equivalent mutations do not justify brittle assertions.
Use `cargo llvm-cov nextest` for suite coverage. Read changed-line and branch gaps
as missing-behavior prompts, not correctness scores; check the toolchain requirements
for optional branch and doc-test coverage rather than assuming they are included.

## Runner and flaky tests

Do default to `cargo nextest run` locally and in CI, beside `cargo test --doc`.
Benefits: process-per-test isolation, parallelism, retries that mark flaky tests,
partitioning, and JUnit output. Costs: a separate binary, a separate doctest run,
and broken assumptions about state shared across tests in one process, usually
revealing an isolation bug. Use plain `cargo test` only if nextest cannot be installed.
Process isolation does not isolate files, ports, databases, or external services.

Do diagnose intermittent failures with repeated runs and shuffled order where the
runner supports it; vary concurrency and preserve seeds, output, and initial failures.
Keep retries off by default. If explicitly enabled for diagnosis, nextest marks an
eventual success flaky; do not report it as a clean initial pass.
Quarantine only with an owner, issue, expiry, and continued diagnostic execution.
Use `test-log` for logging/tracing setup, not assertions on incidental log lines.
Use `serial_test` only as a last resort for unavoidable shared resources; its
process-local locks do not coordinate nextest processes. File locks or runner-level
resource scheduling must cover the actual sharing scope.

## Bad tests and fixes

See the `quality-testing` skill's `references/bad-tests.md` for language-neutral pairs covering removal checks, copied oracles, call-order mocks, side channels, copies instead of parameters, logic in tests, sleeps, assertion-free tests, eager tests, mystery guests, type re-checks, tampering, and whole-object snapshots.

### Real-time delays in async tests

Bad:

```rust
#[tokio::test]
async fn lease_expires() {
    let lease = Lease::new(std::time::Duration::from_secs(30));
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    assert!(lease.is_expired());
}
```

Waiting on real time makes this test slow and dependent on wall-clock scheduling rather than controlled Tokio time.

Fix:

```rust
#[tokio::test(start_paused = true)]
async fn lease_expires() {
    let lease = Lease::new(std::time::Duration::from_secs(30));
    tokio::time::advance(std::time::Duration::from_secs(30)).await;
    assert!(lease.is_expired());
}
```

### Mocking a test-only internal trait

Bad:

```rust
#[mockall::automock]
trait PriceStep { fn subtotal(&self) -> u32; }
#[test]
fn adds_shipping() {
    let mut step = MockPriceStep::new();
    step.expect_subtotal().times(1).return_const(20_u32);
    assert_eq!(total_with_step(&step), 25);
}
```

A trait created only to mock an internal step and a `.times(1)` expectation lock the test to implementation details.

Fix:

```rust
struct FakeQuotes;
impl QuoteClient for FakeQuotes {
    fn price(&self, _sku: &str) -> u32 { 20 }
}
#[test]
fn adds_shipping() {
    assert_eq!(order_total("book", &FakeQuotes), 25);
}
```

### Unexplained fallible setup

Bad:

```rust
#[test]
fn receipt_total_is_preserved() {
    let receipt = parse_receipt(&load_fixture("receipt.json").unwrap()).unwrap();
    assert_eq!(receipt.total, 25);
}
```

Chained `.unwrap()` calls obscure which setup operation failed and why success was expected.

Fix:

```rust
#[test]
fn receipt_total_is_preserved() -> Result<(), Box<dyn std::error::Error>> {
    let text = load_fixture("receipt.json")?;
    let receipt = parse_receipt(&text)?;
    assert_eq!(receipt.total, 25);
    Ok(())
}
```

## Do not write

- `trybuild` or compile-fail tests added only to prove a removed item is gone.
  Delete obsolete tests; reserve compiler tests for deliberate macro/API contracts.
- Tests re-checking type-system guarantees, such as assigning a typed value to the
  same type or proving an exhaustive match accepts its already-checked variants.
- Tests for trivial getters, private helper details, removed files, or export absence.
- Expected results computed by copying the implementation's algorithm.
- A second copy of a scenario already protected at another level without a distinct risk.

## Defaults by use case

| Use case | Default |
| --- | --- |
| Pure logic | `#[test]`, built-in assertions; named `rstest` cases only for repetition |
| I/O adapters | Handwritten fake plus real boundary contracts; `testcontainers` for service semantics |
| HTTP handlers | Actual router/service harness; `wiremock` for outbound dependencies |
| Async/concurrency | `tokio::test`, paused time and joins; focused `loom` or `shuttle` models |
| CLI | Library core tests plus a few subprocess exit/stdout/stderr contracts; small `insta` outputs |
| Parsers | Boundary examples, `proptest` invariants, targeted `cargo-fuzz` campaigns |
| CI | `cargo nextest run --profile ci` and `cargo test --doc`; explicit integration and targeted mutation/coverage runs |

## Sources

- [Rust test organization](https://doc.rust-lang.org/book/ch11-03-test-organization.html), [doc tests](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html).
- [Nextest retries](https://nexte.st/docs/features/retries/), [partitioning](https://nexte.st/docs/ci-features/partitioning/), [JUnit](https://nexte.st/docs/machine-readable/junit/).
- [Rstest](https://docs.rs/rstest/latest/rstest/), [Insta](https://insta.rs/docs/), [redactions](https://insta.rs/docs/redactions/), [Proptest persistence](https://proptest-rs.github.io/proptest/proptest/failure-persistence.html).
- [Mockall](https://docs.rs/mockall/latest/mockall/), [Wiremock](https://docs.rs/wiremock/latest/wiremock/), [Testcontainers](https://docs.rs/testcontainers/latest/testcontainers/), [Tokio test](https://docs.rs/tokio/latest/tokio/attr.test.html).
- [Loom](https://docs.rs/loom/latest/loom/), [Shuttle](https://docs.rs/shuttle/latest/shuttle/), [fuzzing](https://rust-fuzz.github.io/book/cargo-fuzz.html), [Bolero](https://docs.rs/bolero/latest/bolero/).
- [Mutation in diffs](https://mutants.rs/in-diff.html), [LLVM coverage](https://github.com/taiki-e/cargo-llvm-cov), [Serial test](https://docs.rs/serial_test/latest/serial_test/).
