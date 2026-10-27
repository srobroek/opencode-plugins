# Commands, CLIs and the operating system

Sources: [hyperfine](https://github.com/sharkdp/hyperfine) (2.0 release notes), [perf examples](https://www.brendangregg.com/perf.html), [xctrace(1)](https://keith.github.io/xcode-man-pages/xctrace.1.html).

## hyperfine (whole-command wall time)

```sh
hyperfine --warmup 3 'mytool --input big.json'                     # baseline
hyperfine --warmup 3 'old/mytool in.json' 'new/mytool in.json'      # first command is the reference
hyperfine --runs 30 --export-json result.json --export-markdown result.md 'cmd'
hyperfine --prepare 'sync; echo 3 | sudo tee /proc/sys/vm/drop_caches' 'cmd'   # cold cache (Linux)
hyperfine -L branch main,perf-fix --setup 'git switch {branch} && make' './app'
hyperfine -P threads 1 8 --env 'THREADS={threads}' './app'
```

hyperfine 2 changed defaults; check `hyperfine --version`:

- Commands run directly, without a shell. Pass `-S` for pipes, redirects, globs, `&&` or `~`. hyperfine 1.x always used a shell (`-N` disabled it).
- It reports wall time and peak memory by default; `--metrics time_wall_clock:ms,memory_peak_resident:MiB,instructions` picks others. `--time-unit`, `--sort` and `--reference` are gone.
- The `--export-json` schema is version 2 (`results[i].summary.time_wall_clock.mean`).

Without hyperfine: `/usr/bin/time -l cmd` (macOS) or `/usr/bin/time -v cmd` (Linux) for one run's wall, CPU and max RSS.

## Linux perf

```sh
perf stat -d ./app                   # counters: task-clock, cycles, instructions, IPC, cache and branch misses
perf record -F 99 -g ./app           # sample on-CPU stacks at 99 Hz
perf record -F 99 -g -p PID sleep 30 # attach for 30 s
perf report                          # interactive; --stdio for text
perf script | stackcollapse-perf.pl | flamegraph.pl > out.svg   # Brendan Gregg's FlameGraph scripts
```

Use `--call-graph dwarf` when frame pointers are missing. Unprivileged use may need `kernel.perf_event_paranoid` lowered. `samply record ./app` gives the same data in Firefox Profiler with less setup. Off-CPU and IO latency: `offcputime` and `biolatency` from bcc/bpftrace, or `perf trace`.

## macOS Instruments

Needs full Xcode (not only the Command Line Tools) for `xctrace`.

```sh
xctrace list templates
xctrace record --template 'Time Profiler' --time-limit 30s --launch -- ./app --flag
xctrace record --template 'Allocations' --attach <pid>
open *.trace                         # inspect in Instruments
```

Time Profiler for CPU, Allocations and Leaks for memory, System Trace for threads, syscalls and waiting. Without Xcode, `samply record` works on macOS and `sample <pid> 10` prints a quick call-tree sample.

## Request latency

Measure from the client side with a fixed load (`oha -z 30s -c 50 URL`, `wrk`, `k6`) and report p50/p95/p99, not the mean. Then find where the time goes inside the request: server-side timing logs or tracing spans per stage (database, downstream calls, serialisation), the database's `EXPLAIN ANALYZE` for slow queries, and a wall-clock profile of the server under that load.
