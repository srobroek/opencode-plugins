---
name: lang-typescript-profiling
description: Use for Bun or Node profiling and benchmarks (--cpu-prof, --heap-prof, heap snapshots, mitata, tinybench).
metadata:
  opencode/autoinvoke: false
---

# JavaScript and TypeScript (Bun, Node)

Sources: [Bun benchmarking docs](https://bun.com/docs/project/benchmarking) (checked against `bun --help`, Bun 1.4), [Node CLI docs](https://nodejs.org/api/cli.html) (v26), [mitata](https://github.com/evanwashere/mitata), [tinybench](https://github.com/tinylibs/tinybench), [Clinic.js](https://github.com/clinicjs/node-clinic).

Tooling only. The method (target, fixed workload, baseline with variance, one change at a time, re-measure, report) is the `quality-profiling` skill; load it first if it is not loaded.

## Bun

CPU (writes on exit):

```sh
bun --cpu-prof-md script.ts            # markdown profile: grep-friendly, read it directly
bun --cpu-prof script.ts               # .cpuprofile for Chrome DevTools (Performance → Load profile) or VS Code
bun --cpu-prof --cpu-prof-md --cpu-prof-dir ./profiles script.ts
BUN_OPTIONS="--cpu-prof-md" bun run start   # through a script or wrapper
```

`--cpu-prof-interval=<µs>` changes the sampling interval (default 1000). Prefer `--cpu-prof-md` when you will read the profile yourself.

Memory:

```sh
bun --heap-prof-md script.ts           # markdown heap summary on exit
bun --heap-prof script.ts              # V8-format snapshot (.heapprofile); load in DevTools Memory tab ("All Files", or rename to .heapsnapshot)
```

Bun's heap profile is a single snapshot taken at exit; `--heap-prof-interval` is accepted only for Node compatibility. For growth, take snapshots at chosen points and compare them:

```ts
import { heapStats } from "bun:jsc"
console.log(heapStats())                // heapSize, objectCount, objectTypeCounts, extraMemorySize
Bun.gc(true)                            // force a full GC before measuring
await Bun.write("heap.json", JSON.stringify(Bun.generateHeapSnapshot()))   // Safari/WebKit Timeline → JavaScript Allocations
// Bun.generateHeapSnapshot("v8") gives a DevTools-compatible snapshot
```

`process.memoryUsage()` and `process.memoryUsage.rss()` report RSS, which includes native memory outside the JS heap.

## Node

```sh
node --cpu-prof --cpu-prof-dir ./profiles app.js     # CPU.<date>.<pid>...cpuprofile on exit
node --heap-prof --heap-prof-dir ./profiles app.js   # sampling allocation profile, Heap.<...>.heapprofile on exit
node --heapsnapshot-signal=SIGUSR2 app.js            # kill -USR2 <pid> writes a retained-heap snapshot
node --inspect app.js                                # live DevTools: chrome://inspect
```

Both `--cpu-prof` and `--heap-prof` are stable since v22.4 / v20.16 and write when the process exits normally. For a server, exit cleanly after the workload (handle `SIGINT` with `process.exit()`), or the profile is lost when the process is killed. Load `.cpuprofile` and `.heapprofile` in Chrome DevTools or VS Code, or convert with speedscope.

Clinic.js (`clinic doctor|flame|bubbleprof -- node server.js`) still runs but is no longer actively maintained and may give inaccurate results on current Node; prefer `--cpu-prof` and DevTools.

## Micro-benchmarks

Bun recommends mitata; tinybench is a common alternative under Node and Vitest.

```ts
import { bench, boxplot, do_not_optimize, run, summary } from "mitata"
summary(() => {
  bench("current", () => do_not_optimize(parseCurrent(input)))
  bench("candidate", () => do_not_optimize(parseCandidate(input)))
})
await run()
```

```ts
import { Bench } from "tinybench"
const bench = new Bench({ time: 500 })
bench.add("current", () => parseCurrent(input)).add("candidate", () => parseCandidate(input))
await bench.run()
console.table(bench.table())
```

Whole commands (`bun run build`, a CLI): use `hyperfine`, see the `quality-profiling` skill's system reference. HTTP servers: `oha`, `bombardier` or `wrk` with fixed concurrency and duration; Node-based generators can be slower than `Bun.serve`.

## Reading the output

- `--cpu-prof-md`: the "Hot Functions (Self Time)" table ranks where CPU is spent; the "Call Tree (Total Time)" table shows which caller drives it. Native frames (`[native code]`) such as `JSON.parse` or `indexOf` count against the JS caller that invoked them.
- `.cpuprofile` in DevTools: Bottom-Up sorts by self time; Call Tree by total; the flame chart shows time order (look for long tasks and GC bars).
- Heap: compare two snapshots in DevTools (Comparison view) and sort by size delta; open the Retainers pane of a growing object to find who holds it. `--heap-prof-md` lists objects and GC roots as greppable tables.

## Pitfalls

- An idle or IO-bound server shows almost nothing in a CPU profile; time the request stages (database, fetches, serialisation) instead, or compare wall time with CPU time.
- `bun --watch`, `--hot`, `--inspect` and dev-mode frameworks slow everything down; profile the production command.
- TypeScript frames map to source only with source maps (`--enable-source-maps` on Node; Bun maps transpiled code itself).
- The first requests run unoptimised code (JIT warm-up); send warm-up load before profiling steady state.
- A profile is lost when the process is killed with SIGKILL or crashes before exit.
