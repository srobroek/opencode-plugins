---
name: lang-python-profiling
description: Use for Python profiling and benchmarks (py-spy, profiling.sampling, scalene, memray, cProfile, pyperf).
metadata:
  opencode/autoinvoke: false
---

# Python

Sources: [py-spy](https://github.com/benfred/py-spy) (0.4), [`profiling.sampling`](https://docs.python.org/3/library/profiling.sampling.html) and [`profiling.tracing`](https://docs.python.org/3/library/profiling.tracing.html) (Python 3.15), [Scalene](https://github.com/plasma-umass/scalene) (2.x), [memray](https://github.com/bloomberg/memray), [SnakeViz](https://jiffyclub.github.io/snakeviz/).

Tooling only. The method (target, fixed workload, baseline with variance, one change at a time, re-measure, report) is the `quality-profiling` skill; load it first if it is not loaded.

## Sampling CPU and wall time (start here)

Low overhead, no code changes, can attach to a running process.

```sh
py-spy record -o profile.svg -- python app.py        # flame graph SVG; --format speedscope for speedscope.app
py-spy record -o profile.svg --pid 12345             # attach (Linux may need sudo or ptrace permission)
py-spy top --pid 12345                               # live top-like view
py-spy dump --pid 12345                              # one stack per thread: where is it stuck?
```

Useful flags: `--idle` includes waiting frames (IO, locks, sleep), `--gil` keeps only threads holding the GIL, `--native` includes C/C++/Cython frames, `--subprocesses` follows multiprocessing and worker pools.

Python 3.15+ ships the same kind of profiler in the standard library (Tachyon):

```sh
python -m profiling.sampling run --flamegraph -o profile.html app.py
python -m profiling.sampling run -m mypackage.module arg1
python -m profiling.sampling attach 12345
python -m profiling.sampling dump 12345
```

`--mode` selects wall-clock (default), CPU, or GIL sampling; compare wall and CPU profiles to separate computing from waiting.

## Line-level CPU, memory and GPU

Scalene 2 uses `run` and `view` subcommands:

```sh
scalene run app.py --- --app-arg            # writes scalene-profile.json; args after ---
scalene run --cpu-only app.py               # faster, CPU only
scalene view --cli                          # read in the terminal
scalene view --html                         # scalene-profile.html
```

It separates Python time from native time and attributes memory allocation and copy volume per line; `--memory-leak-detector` is experimental.

## Memory

```sh
python -m memray run -o out.bin app.py
python -m memray flamegraph out.bin          # HTML flame graph of allocations; also: table, tree, summary, stats
```

`--native` adds C-extension frames; `memray attach <pid>` profiles a live process. `tracemalloc` (stdlib) snapshots and `compare_to` diffs are enough for a quick leak check.

## Deterministic (call counts)

Exact call counts with higher overhead, which inflates small hot functions; use it to count calls, not to rank time.

```sh
python -m cProfile -o out.prof app.py        # 3.15+: python -m profiling.tracing -o out.prof app.py
python -m pstats out.prof                    # sort cumulative / tottime, stats 20
snakeviz out.prof                            # browser icicle/sunburst view
```

`cProfile` stays available as an alias of `profiling.tracing`; the pure-Python `profile` module is deprecated.

## Benchmarks

`python -m timeit -s "setup" "stmt"` for snippets; `pyperf` for stable repeated runs with warm-up and outlier detection (`pyperf compare_to old.json new.json`); `pytest-benchmark` inside a test suite. Whole scripts: `hyperfine`, see the `quality-profiling` skill's system reference.

## Reading the output

- py-spy and Tachyon flame graphs: width is sample share; `--idle` frames in `socket.recv`, `select`, `time.sleep` or lock acquisition mean waiting, not computing.
- `pstats`: `tottime` is self time, `cumtime` includes callees; sort by `tottime` to find the hot function and by `cumtime` to find the expensive entry point. `ncalls` like `1200/3` means recursion (total/primitive).
- Scalene: per-line Python vs native vs system time; a line with high native time is already in C, so speed it up by calling it less, not by rewriting Python around it. High "copy volume" means data crossing between Python and native (for example NumPy conversions).
- memray: the flame graph shows allocation stacks at peak memory by default; `--leaks` shows memory still allocated at exit.

## Pitfalls

- cProfile overhead inflates many small calls; never rank functions by cProfile time alone, confirm with a sampling profiler.
- Multithreaded CPU work is serialised by the GIL (unless running a free-threaded build); use `--gil` or `--mode gil` to check whether threads are waiting on it.
- Async code: the hot coroutine may appear under the event loop's frames; py-spy shows the coroutine stack while it runs, not while awaiting.
- Profile the deployed interpreter and dependency versions; NumPy, pandas and C extensions differ a lot between versions and builds.
