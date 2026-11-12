# Testing tools

Choose Rust test tools by the failure they reveal; see [Rust testing practice](../../lang-rust-testing/references/practice.md) for idioms and defaults, and `lang-rust-quality` for checks.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Unit/integration runner | `cargo-nextest` `0.9` locally and in CI, plus `cargo test --doc` | Plain `cargo test` only when nextest cannot be installed | Assuming process isolation covers shared external resources or replaces doctests. |
| Async | `tokio` `1.54` test facilities | Sync test for pure logic | Real sleeps and arbitrary delays; unjoined tasks. |
| Parameterization | `rstest` `0.28` | Ordinary table loops for simple cases | Fixture frameworks for one value. |
| Properties | `proptest` `1.12` | `quickcheck` `1.1` for simpler arbitrary-value tests | Losing shrunk failures/seeds; generating only valid cases for parsers. |
| Snapshots | `insta` `1.49` | Direct semantic assertions for small outputs | Automatic acceptance; unstable IDs/time in snapshots. |
| Trait doubles | Real implementations or handwritten fakes at owned boundaries | `mockall` `0.15` when boundary interactions are contractual | Mocking internal call order or third-party types throughout business code. |
| HTTP mocking | `wiremock` `0.6` | `httpmock` `0.9` for its API | Mocks mistaken for provider compatibility evidence. |
| HTTP recording | Reviewed redacted fixtures with `wiremock` `0.6` | Approved recording tool when a named gap requires it | Unverified recorder recommendation; recording tokens or personal data. |
| Factories | Small Rust builders/functions | `fake` `5.1` for seeded broad fixture generation | Random default data making failures irreproducible. |
| External services | `testcontainers` `0.28` | Existing isolated provisioned test infrastructure | Mocking away transaction/constraint semantics; assuming Docker exists in CI. |
| Contract/property API | `Schemathesis` `4.33` via `toolchain-api` | Existing compatible contract suite | Archived Dredd for new OpenAPI adoption. |
| Load | `oha` `1.16` for simple HTTP load | `k6` `2.3` for scripted scenarios | Production load without authorization; framework benchmark rankings as app evidence. |
| Mutation | `cargo-mutants` `27.1` with `--in-diff` for critical changed logic | Periodic broader runs; regular tests first | Whole-project mutation as an unconditional fast PR gate; test-only diffs assumed to select mutants. |
| Fuzz | `cargo-fuzz` `0.13` | `bolero` `0.13` unified property/fuzz setup; `afl` `0.18` alternate engine | Discarding failure corpora or unbounded CI campaigns. |
| Concurrency | `loom` `0.7` | `shuttle` `0.9` for its exploration model | Assuming ordinary stress tests prove race freedom. |
| Benchmarks | `criterion` `0.8` | `divan` `0.1` for ergonomic/allocation benchmarking | Uncontrolled microbenchmarks without representative workload. |
| Coverage | `cargo-llvm-cov` `0.9` with `cargo llvm-cov nextest` | Existing reviewed coverage tooling | Percentage as correctness proof; assuming optional branch/doc coverage is included. |
| Test diagnostics | `test-log` `0.2`, `pretty_assertions` `1.4` | `serial_test` `4` only for unavoidable shared state; `claims` `0.8` for focused assertions | Serializing tests instead of isolating resources. |

## Rules

- Test pure logic directly and adapters against real semantics. Keep contracts for fakes and real implementations aligned.
- Preserve failing seeds/corpora, isolate ports/databases/files, inject clocks, and await conditions. Review snapshot changes manually.
- Run benchmarks on pinned configurations. Use telemetry test exporters from `observability.md`, not network backends for ordinary tests.

## Sources

- [Nextest](https://nexte.st/), [Proptest](https://crates.io/crates/proptest), [Insta](https://crates.io/crates/insta), [Wiremock](https://docs.rs/wiremock/latest/wiremock/), [Testcontainers](https://docs.rs/testcontainers/latest/testcontainers/).
- [Mutation](https://github.com/sourcefrog/cargo-mutants), [Fuzz](https://github.com/rust-fuzz/cargo-fuzz), [Coverage](https://crates.io/crates/cargo-llvm-cov), [Crate registry](https://crates.io/).
- [Schemathesis](https://github.com/schemathesis/schemathesis), [Oha](https://github.com/hatoo/oha), [k6](https://github.com/grafana/k6).
