---
name: quality-profiling
description: Use when code, an endpoint, a build or a CLI is slow, regressed or uses too much memory; profile, benchmark, fix.
---

# Performance profiling

This skill is the method only. Before you read code or measure, load the tooling skill for the language in scope with the skill tool, by id, in this same turn, even when the cause looks obvious. That skill has the commands, how to read their output, and pitfalls.

| Code in scope | Tooling skill |
| --- | --- |
| TypeScript or JavaScript on Bun or Node | `lang-typescript-profiling` |
| Python | `lang-python-profiling` |
| Go | `lang-go-profiling` |
| Rust | `lang-rust-profiling` |

Whole commands, native code, or a language without a tooling skill: [system](references/system.md) (hyperfine, Linux perf, macOS Instruments).

TRIGGER
+ Something got slow, regressed, times out, or uses too much CPU, memory, or IO.
+ Asked to optimise, benchmark, compare two implementations, or set a performance budget.
- A correctness bug that only looks like slowness (hang, deadlock, infinite loop) → the `quality-code-design` skill's debugging reference first.
- Guessing at a fix without a measurement is not optimising; measure first.

## Workflow

1. **Target.** State the metric and the goal: p95 latency of `GET /orders` under 200 ms, peak RSS under 1 GiB, `build` under 30 s. No target: ask, or propose one and say so.
2. **Reproduce with a fixed workload.** Same input, data size, flags, build mode (release/optimised), and concurrency every run. Script it so one command produces the number.
3. **Baseline with variance.** Warm up, then take repeated samples (≥10 runs, or a tool that picks the count). Record mean or median *and* spread (stddev, min–max, or p50/p95/p99 for latency). Note machine, versions, and load. Read [hygiene](references/hygiene.md) before trusting any number.
4. **Classify the bottleneck** before picking a profiler: CPU-bound (a core pinned), memory (RSS growth, GC time), IO or waiting (low CPU, high wall time), or lock/queue contention. Compare user+sys CPU time to wall time: close → CPU; far below → waiting.
5. **Profile** the same fixed workload with a profiler of that type, using the commands from the language's tooling skill. A cause spotted by reading the code is a hypothesis until the profile confirms it. Read the result as in [reading profiles](references/reading-profiles.md).
6. **One hypothesis, one change.** Write the hypothesis ("`parseRow` allocates per field; reusing a buffer cuts its 40% self time"), make only that change, and re-measure with the step-3 protocol.
7. **Keep or revert.** Keep the change only when the difference exceeds the noise (non-overlapping spread, or a significance test such as `benchstat` or criterion's). Otherwise revert it; a neutral change that adds complexity is a regression.
8. **Stop at the target.** Do not keep optimising past the goal unless asked.
9. **Report** before/after with the same protocol: metric, workload, runs, mean±stddev or percentiles, machine and load, the change, and what the profile showed. Add a benchmark or budget check when the repository has a place for one.

## Profiler types

| Question | Profiler type |
| --- | --- |
| Where does CPU time go? | On-CPU sampling profiler, read as a flame graph |
| Why is it slow while CPU is low? | Wall-clock or off-CPU sampling, tracing, block/lock profiles |
| What allocates, and what drives GC? | Allocation profile |
| What keeps memory alive, or leaks? | Heap snapshots compared over time |
| How long does the whole command take? | `hyperfine` ([system](references/system.md)) |
| Is variant B faster than A? | Micro-benchmark harness with warm-up and a significance test |

Prefer a sampling profiler first: tracing profilers distort small hot functions. Check the installed tool's `--help` before relying on a flag; versions change flags.
