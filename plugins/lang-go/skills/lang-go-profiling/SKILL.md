---
name: lang-go-profiling
description: Use for Go profiling and benchmarks (go test -bench, pprof CPU/heap/block profiles, go tool trace, benchstat).
metadata:
  opencode/autoinvoke: false
---

# Go

Sources: [Go diagnostics](https://go.dev/doc/diagnostics), [`testing`](https://pkg.go.dev/testing), [`net/http/pprof`](https://pkg.go.dev/net/http/pprof), [benchstat](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat). Checked against `go help testflag` on Go 1.27.

Tooling only. The method (target, fixed workload, baseline with variance, one change at a time, re-measure, report) is the `quality-profiling` skill; load it first if it is not loaded.

## Benchmarks and profiles from tests

```go
func BenchmarkParse(b *testing.B) {
	in := loadFixture()          // setup outside the loop is not timed
	b.ReportAllocs()
	for b.Loop() {               // Go 1.24+; older code uses for i := 0; i < b.N; i++
		Parse(in)
	}
}
```

```sh
go test -run='^$' -bench=Parse -benchmem -count=10 > old.txt
# make the change
go test -run='^$' -bench=Parse -benchmem -count=10 > new.txt
benchstat old.txt new.txt                 # go install golang.org/x/perf/cmd/benchstat@latest

go test -run='^$' -bench=Parse -cpuprofile cpu.out -memprofile mem.out
go test -run='^$' -bench=Parse -blockprofile block.out -mutexprofile mutex.out
go test -run='^$' -bench=Parse -trace trace.out
```

benchstat reports the change with a confidence interval and marks it `~` when not significant; run `-count` of 10 or more.

## Live services

```go
import _ "net/http/pprof"   // registers /debug/pprof/ on http.DefaultServeMux; serve it on an internal port only
```

```sh
go tool pprof -http=:8081 'http://localhost:6060/debug/pprof/profile?seconds=30'   # CPU
go tool pprof -http=:8081 http://localhost:6060/debug/pprof/heap                   # live heap (-sample_index=alloc_space for allocations)
go tool pprof http://localhost:6060/debug/pprof/goroutine                          # stuck or leaked goroutines
go tool pprof http://localhost:6060/debug/pprof/block      # needs runtime.SetBlockProfileRate; mutex needs SetMutexProfileFraction
curl -o trace.out 'http://localhost:6060/debug/pprof/trace?seconds=5' && go tool trace trace.out
```

## Reading pprof

`top` / `top -cum` rank by self / cumulative time; `list Func` shows per-line cost; `-http` opens graph, flame graph and source views. Compare runs with `go tool pprof -diff_base old.pprof new.pprof`. The CPU profile shows on-CPU time only; latency spent waiting shows in the block, mutex and goroutine profiles and the execution trace (scheduler, GC, syscalls).

## Pitfalls

- The compiler removes work whose result is unused; assign results to a package-level sink, or rely on `b.Loop()`, which keeps the loop body's calls alive.
- `-benchmem` allocations per op often matter more than ns/op: each allocation costs GC time later, outside the benchmark.
- `GOMAXPROCS` defaults to the cgroup CPU limit on Linux since Go 1.25; benchmark with the same limit as production.
- CPU profiles of a mostly idle server are empty; profile under load, and use the block, mutex and goroutine profiles for latency.
- The heap profile's default `inuse_space` shows live memory; switch to `alloc_space` or `alloc_objects` to find allocation churn.
