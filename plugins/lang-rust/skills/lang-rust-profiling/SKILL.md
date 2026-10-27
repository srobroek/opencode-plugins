---
name: lang-rust-profiling
description: Use for Rust profiling and benchmarks (samply, cargo flamegraph, perf, criterion baselines, dhat).
metadata:
  opencode/autoinvoke: false
---

# Rust

Sources: [samply](https://github.com/mstange/samply), [flamegraph-rs](https://github.com/flamegraph-rs/flamegraph), [Criterion.rs book](https://bheisler.github.io/criterion.rs/book/) (crate 0.8, now at criterion-rs/criterion.rs), [perf examples](https://www.brendangregg.com/perf.html).

Tooling only. The method (target, fixed workload, baseline with variance, one change at a time, re-measure, report) is the `quality-profiling` skill; load it first if it is not loaded.

## Build for profiling

Optimised code with symbols. Add a profile so release stays unchanged:

```toml
# Cargo.toml or ~/.cargo/config.toml
[profile.profiling]
inherits = "release"
debug = true
```

```sh
cargo build --profile profiling
```

Benchmarks use the `bench` profile; set `[profile.bench] debug = true` to profile them. Linux with lld (the default linker since Rust 1.90) or mold: add `-Clink-arg=-Wl,--no-rosegment` to `rustflags`, or perf produces broken stacks.

## CPU sampling

```sh
samply record ./target/profiling/app --flag      # opens Firefox Profiler when the command exits
cargo flamegraph --profile profiling --bin app -- --flag   # writes flamegraph.svg
cargo flamegraph --bench my_bench -- --bench     # a criterion bench in benchmark mode
cargo flamegraph --unit-test -- module::test_name
```

samply uses perf events on Linux and works on macOS without root. cargo-flamegraph uses `perf` on Linux and `xctrace` on macOS. On Linux both may need `echo -1 | sudo tee /proc/sys/kernel/perf_event_paranoid` (or a less permissive value your policy allows). Raw `perf record -g` / `perf report` works as in the `quality-profiling` skill's system reference.

## Memory

`dhat` (crate `dhat`, heap profiling via a global allocator in a test or bench build), `heaptrack ./app` on Linux, Instruments Allocations on macOS. Count allocations in hot paths before chasing RSS.

## Micro-benchmarks (criterion)

```toml
[dev-dependencies]
criterion = "0.8"

[[bench]]
name = "parse"
harness = false
```

```rust
use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

fn bench_parse(c: &mut Criterion) {
    c.bench_function("parse 4k", |b| b.iter(|| mycrate::parse(black_box(INPUT))));
}
criterion_group!(benches, bench_parse);
criterion_main!(benches);
```

```sh
cargo bench -- --save-baseline before    # on the baseline commit
cargo bench -- --baseline before         # after the change: reports change and significance
```

`cargo test --benches` checks benches compile and run without measuring. `divan` is a lighter alternative with allocation counting.

## Reading the output

- Firefox Profiler (samply): Call Tree with "Invert call stack" ranks self time; the flame graph tab shows the merged stacks; the track graph shows CPU use over time per thread.
- Heavily inlined release code attributes time to the caller; `debug = true` lets samply show inlined frames. Mangled or `<unknown>` frames mean missing debug info.
- Wide `alloc::`, `__rust_alloc`, `memcpy` or `drop_in_place` frames point at allocation, copying or drop cost: reuse buffers, borrow instead of clone, preallocate with `with_capacity`.
- Criterion prints the new estimate with a confidence interval and "Performance has improved/regressed" or "No change in performance detected"; trust only changes outside the noise threshold.

## Pitfalls

- Never profile or benchmark a debug build; `cargo run` without `--release` or a release-based profile is 10–100× slower and has different hot spots.
- `cargo bench` runs every bench; pass a filter (`cargo bench parse`) to keep runs short and comparable.
- Criterion baselines live under `target/criterion`; `cargo clean` deletes them.
- Async runtimes (tokio) show worker threads parked in `epoll`/`kevent` when idle; that is waiting, not cost. Use `tokio-console` or tracing spans for task-level latency.
