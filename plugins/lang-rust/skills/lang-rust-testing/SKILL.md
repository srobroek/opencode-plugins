---
name: lang-rust-testing
description: Use to write or fix Rust tests (unit and integration layout, cargo nextest, doc tests, proptest, insta snapshots, tokio).
metadata:
  opencode/autoinvoke: false
---

# Rust Testing

Sources: [The Rust Book: test organization](https://doc.rust-lang.org/book/ch11-03-test-organization.html), [rustdoc documentation tests](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html), [cargo-nextest](https://nexte.st/docs/running/), [proptest book](https://proptest-rs.github.io/proptest/), [insta](https://insta.rs/docs/), [`tokio::test`](https://docs.rs/tokio/latest/tokio/attr.test.html). Checked with cargo 1.99, cargo-nextest 0.9, proptest 1.12 and insta 1.49.

What to test and which double to use is the `quality-testing` skill. This skill is the
Rust idioms. Run the suite as in `lang-rust-quality`.

## Layout

- Unit tests sit in the file they test, in `#[cfg(test)] mod tests { use super::*; … }`,
  and can reach private items.
- Integration tests in `tests/` use only the public API. Each `tests/*.rs` file is a
  separate crate that compiles and links on its own; past a few files, use one
  `tests/it/main.rs` with `mod` files so the suite links once. Shared helpers go in a
  module (`tests/common/mod.rs`), not a top-level `tests/common.rs`, which cargo would
  run as a test crate.
- Doc tests: code blocks in `///` comments of a library crate are compiled and run.
  Mark them `no_run` (compile only), `compile_fail`, `should_panic` or `ignore` rather
  than deleting them; hide setup lines with a leading `# `.
- Test against traits you own with hand-written fakes. Add `mockall` only when the
  project already uses it.

## Running

```sh
cargo nextest run                            # when the project uses nextest
cargo test --doc                             # nextest does not run doc tests; run them separately
cargo nextest run -p billing refund          # one crate, tests whose name matches
cargo test -p billing refund -- --nocapture  # cargo test: show println! output
cargo nextest run --no-fail-fast             # report every failure, not the first
```

nextest runs each test in its own process, so global state does not leak between
tests and slow tests show up in its summary. CI settings (`fail-fast = false`, JUnit
output) go in a `[profile.ci]` section of `.config/nextest.toml`, selected with
`--profile ci`. Do not add `retries` to hide a flaky test.

## Property tests with proptest

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn round_trips(s in "\\PC*") {               // any string of printable characters
        prop_assert_eq!(decode(&encode(&s)), s);
    }
}
```

Use `prop_assert!` / `prop_assert_eq!` inside `proptest!`, so a failure shrinks instead of
panicking out. Shrunk failures are saved under `proptest-regressions/`; commit that
directory so CI and collaborators replay them. Build domain values with
`any::<T>()`, ranges (`0u32..1000`), `prop::collection::vec(…, 0..10)` and
`prop_compose!`.

## Snapshots with insta

```rust
#[test]
fn renders_user() {
    insta::assert_yaml_snapshot!(user(), { ".id" => "[id]" });   // redact unstable fields
}
```

- `assert_snapshot!` for strings, `assert_debug_snapshot!` for `Debug`,
  `assert_yaml_snapshot!` / `assert_json_snapshot!` for `Serialize` (crate features
  `yaml` / `json`; redactions need `redactions`).
- Review new and changed snapshots with `cargo insta review` (or `cargo insta test
  --review`) and commit the `.snap` files. On CI, insta writes nothing and a mismatch
  fails; `cargo insta test --unreferenced=reject` also fails on stale snapshot files.

## Async and time

```rust
#[tokio::test(start_paused = true)]               // needs tokio's test-util feature
async fn times_out() {
    let result = with_timeout(Duration::from_secs(30), never_finishes()).await;
    assert!(result.is_err());                     // runs instantly: paused time auto-advances
}
```

`#[tokio::test]` uses a current-thread runtime; add `flavor = "multi_thread"` only when
the code under test needs real parallelism. Database tests are in `lang-rust-persistence`
(`#[sqlx::test]`).
