# Benchmark hygiene

A number is only as good as the conditions it was taken under. Record them with the result.

## Control noise

- **Check load first.** Run `uptime` (or read `/proc/loadavg`) before and after. A load average above the core count means other work is competing; this matters on shared and agent-heavy machines, where a load of 50 is not unusual. When you cannot quiet the machine: run baseline and candidate interleaved in the same session (hyperfine with both commands, `-count` alternation, criterion's saved baseline), use more runs, prefer medians and minimums over means, and compare CPU time (user+sys) or instruction counts, which load disturbs less than wall time. Say in the report that the machine was loaded.
- **Isolate.** Close other heavy processes, stop watchers and dev servers you started, disable debug logging and tracing. On Linux, pin with `taskset -c 2 cmd` and set the governor to `performance`; on laptops, stay on mains power and watch for thermal throttling on long runs.
- **Same build.** Profile and benchmark the optimised build (release, `NODE_ENV=production`, no `--inspect`), with symbols kept for profiling (Rust `debug = true` in the profile, Go default builds keep them).
- **Warm up.** Discard the first runs: JIT tiering (JS, JVM, PyPy), disk and page caches, connection pools, lazy imports. Decide deliberately whether you measure cold start (drop caches with a `--prepare` step) or steady state (warm-up runs), and report which.
- **Fix the inputs.** Same data size and shape, seeded randomness, pinned dependency versions. Synthetic micro-inputs often miss the real hot path; prefer a captured real workload, trimmed.
- **Do not measure the harness.** For servers, the load generator must be faster than the server and run with a fixed concurrency and duration (`oha -z 30s -c 50 URL`, `wrk -t4 -c50 -d30s URL`, `bombardier`). Bun's docs warn that Node-based generators such as autocannon can be too slow for `Bun.serve`.

## Statistics

- Report spread, not only the centre: mean±stddev for roughly symmetric timings, median and p95/p99 for latency, min for "best achievable" CPU work.
- Ten runs is a floor. Increase until the spread stabilises.
- Treat a difference smaller than the spread as no difference. Use the tool's comparison: `benchstat old.txt new.txt` (Go), criterion's change report (Rust), hyperfine's relative summary, mitata's `summary()`.
- Watch for bimodal results (GC pauses, cache hits vs misses); report both modes rather than averaging them away.
- A micro-benchmark proves the micro-case. Confirm the end-to-end metric from step 1 moved.

## Micro-benchmark traps

- Dead-code elimination: consume the result (`black_box` in Rust, `do_not_optimize` in mitata, assign to a package-level sink in Go).
- Constant folding: feed inputs the compiler cannot see at build time.
- Setup inside the timed loop: keep it outside (Go `b.Loop()` only times the loop body).
- Allocation and GC cost hidden by short runs: also report allocations (`-benchmem`, `b.ReportAllocs()`, heap stats).
