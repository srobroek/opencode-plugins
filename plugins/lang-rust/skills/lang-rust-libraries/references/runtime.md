# Runtime, builds and architecture helpers

Use Rust's standard facilities first, and select runtime, error and resilience crates for explicit boundaries.

Checked 2026-11-12.

## Runtime comparison

| Option | Fit | Selection and constraints |
| --- | --- | --- |
| `tokio` `1.54` | Broad async networking ecosystem | Default concurrent I/O; latest is not automatically LTS. |
| `smol` `2` | Small modular runtime | Deliberately runtime-independent dependency stack; older release alone is not abandonment. |
| Standard synchronous code | Sequential CLI/batch, modest concurrency | Avoid async when cancellation/runtime complexity buys no useful concurrency. |
| `rayon` `1.12` | Parallel iterators/sustained CPU work | Bounded CPU pool, not async runtime workers. |
| `tokio::task::spawn_blocking` in `tokio` `1.54` | Bridge occasional blocking calls | Bound CPU submissions; started work cannot be aborted. Dedicated threads for persistent loops. |

No Tokio-versus-smol throughput winner was verified. `async-std` `1.13` is discontinued and recommends smol. Tokio LTS lines are `1.51` through March 2027 and `1.53` through September 2027; pin the minor line when selecting LTS.

## Error comparison

| Option | Fit | Selection |
| --- | --- | --- |
| `thiserror` `2` | Typed standard-error derives | Default public library/domain boundary. |
| `anyhow` `1` | Erased errors plus context | Default binary/internal orchestration, after preserving actionable domain types. |
| `snafu` `0.9` | Typed errors/context selectors | Team prefers contextual construction ergonomics. |
| `eyre` `0.6`, `color-eyre` `0.6` | Customizable terminal reports | Human-facing binary reports, not public library API types. |
| `miette` `7` | Source-located diagnostics | Parser/compiler/config errors. |
| `error-stack` `0.8` | Typed context transitions/attachments | Complex diagnostic needs justify additional API model. |

No representative error-overhead comparison was verified; measure backtraces, attachments and rendering separately. Map internal reports to safe public responses.

## Picks

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Toolchain/edition | Stable Rust `1.100`, edition `2024` | Edition `2021` for MSRV below `1.85` | Edition mistaken for dependency MSRV; untested declared `rust-version`. |
| Packaging/workspaces | Cargo workspace, explicit feature/target matrix | Separate crates for real public responsibility boundaries | Extra framework/DI containers for basic construction; use `lang-rust-packaging`. |
| Build caching | `sccache` `0.19`; `cargo-chef` `0.1` for container dependency layers | Existing CI cache recipe | Machine-wide target directories; cache keys ignoring toolchain/features/targets. |
| Cross builds | `cargo-zigbuild` `0.24` when linker portability fits | `cross` `0.2` container workflow | Musl assumed automatically fully static; unverified native libraries/TLS roots/DNS/runtime files. |
| Containers | Pinned multi-stage build, minimal compatible runtime image | Distroless/glibc when loader/libs exist; musl after linkage tests | Small image mistaken for runnable/secure image; base digest left floating. |
| Shutdown | `tokio` `1.54` signal/task lifecycle, bounded drain and telemetry shutdown | Standard synchronous lifecycle for sync apps | Abrupt exit with unjoined work or unflushed telemetry. |
| Retry/backoff | `backon` `1.6`, bounded jittered exponential retries | `reqwest-middleware` `0.5`, `reqwest-retry` `0.9` after compatibility check; existing `tokio-retry` `0.3` | `backoff` `0.4` unmaintained; nested retry amplification or unsafe replay. |
| Circuit breaking | Deadlines, bounded concurrency and retry budgets first | Reviewed platform/application breaker with half-open tests | No universal Rust crate was verified; selecting one by search popularity. |
| Rate limiting | `governor` `0.10`; `tower_governor` `0.8` for HTTP | Shared gateway/store for replica-wide quotas | Local state mistaken for distributed quota enforcement. |
| Channels/coordination | `tokio::sync` from `tokio` `1.54` | `crossbeam` `0.8` synchronous concurrency; standard short mutex sections | Unbounded queues, blocking waits or guards held across awaits. |
| Concurrent maps | Locked standard map first | `dashmap` `6.2` when contention warrants; `papaya` `0.2` read-heavy; `scc` `3.8` for async container needs | DashMap references across await/re-entry, documented deadlock risk. |
| Initialization/locks | Standard `LazyLock`, `OnceLock`, `Mutex` | `once_cell` `1.21` compatibility/features; `parking_lot` `0.13` measured needs | Dependencies by habit; hidden mutable globals. |
| Time/IDs | `jiff` `0.2`, `uuid` `1` | `chrono` `0.4` ecosystem fit; `time` `0.3` focused APIs; `ulid` `3` interoperability | Naive timezone arithmetic; IDs as auth secrets; calling Chrono unmaintained. |
| Feature flags/OpenFeature | Existing provider/AppConfig typed boundary | Evaluate approved OpenFeature implementation/provider when required | No Rust SDK/version was established; do not invent one or write a rules engine. |
| DI/state machines | Explicit constructors, traits, enums | `statig` `0.4` hierarchical states | Containers by habit; `sm` `0.9` needs maintenance investigation. |
| Builders | `bon` `3.10` only when a builder helps | `typed-builder` `0.23` or `derive_builder` `0.20` existing conventions | Builders for trivial values; conversions bypassing invariants. |
| Derives/utilities | Standard iterators/newtypes first | `strum` `0.28`, `itertools` `0.15`, `nutype` `0.8`, `derive_more` `2.1` for named needs | Broad derives accidentally exposing invalid conversions. |
| Buffers/containers | Standard collections, `bytes` `1` for shared byte buffers | `smallvec` `1.16`, `arrayvec` `0.7`, `indexmap` `2.14` for capacity/order requirements | Unmeasured allocation optimizations. |
| Hashing | Standard map hasher | `hashbrown` `0.17`, `ahash` `0.8`, `foldhash` `0.2` after attacker-input review | Noncryptographic hashers on hostile keys without analysis. |
| Allocators | System/default allocator | `mimalloc` `0.1`, `tikv-jemallocator` `0.7` after workload profiling | Benchmark-free allocator replacement. |
| Releases | `release-plz` `0.4` release PRs | `cargo-release` `1.1` operator workflow; `cargo-dist` `0.34` binary distribution | Release automation mistaken for API compatibility evidence. |
| API/docs | Standard rustdoc, docs.rs feature/target metadata | `mdbook` `0.5` narrative docs; `cargo-semver-checks` `0.51` public API gate | Indiscriminate all-features builds with conflicting features. |
| Desktop | `tauri` `2.12`; load `lang-rust-tauri` | `egui` `0.37` immediate-mode tools, `iced` `0.14` Elm-style, `dioxus` `0.7` Rust fullstack | Nested async runtimes, broad IPC permission or identical-webview assumptions. |

## Rules

- Pin toolchains and dependencies, test MSRV and target/features independently, and audit the resolved graph. Recent release activity is not a maintenance SLA.
- Propagate deadlines/cancellation; bound retries and blocking/CPU tasks. Treat backpressure as part of the API.
- Keep typed domain errors; install global runtime/subscriber only in binaries. Native plugins need an explicit stable ABI, not assumptions about Rust ABI.
- Build/deployment commands stay in `lang-rust-quality`, `lang-rust-ci` and `lang-rust-packaging`; desktop details stay in `lang-rust-tauri`.

## Sources

- [Rust stable releases](https://github.com/rust-lang/rust/blob/stable/RELEASES.md), [edition](https://doc.rust-lang.org/edition-guide/rust-2024/index.html), [Tokio LTS](https://github.com/tokio-rs/tokio#bug-patching-policy), [discontinued async-std](https://github.com/async-rs/async-std).
- [Blocking tasks](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html), [DashMap warnings](https://docs.rs/dashmap/latest/dashmap/struct.DashMap.html), [error-stack](https://docs.rs/error-stack/latest/error_stack/).
- [Backoff advisory](https://rustsec.org/advisories/RUSTSEC-2025-0012.html), [docs.rs metadata](https://docs.rs/about/metadata), [Crate registry](https://crates.io/).
