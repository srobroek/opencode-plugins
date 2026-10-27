# Reading profiles

## Flame graphs

- Each box is a stack frame; width is the share of samples where that frame was on the stack. The x-axis is not time (it is sorted alphabetically or merged); an icicle graph is the same thing drawn top-down. Firefox Profiler and Chrome DevTools also offer a time-ordered "flame chart" view, where x *is* time.
- **Self time** is the width of a box not covered by its children: work done in that function itself. **Total (inclusive) time** is the whole box width. Optimise wide boxes with large self time, or a wide parent whose many children each do a little (a loop calling something too often).
- Look for: one plateau dominating (the hot path); the same function under many parents (a shared helper worth fixing once); wide `GC`, `malloc`, `memmove` or runtime frames (allocation pressure); wide `read`, `poll`, `futex`, `epoll_wait` frames in a wall-clock profile (waiting, not computing).
- An on-CPU profile cannot show waiting. Low CPU with high latency needs a wall-clock or off-CPU profile, a trace, or request timing.
- Missing or `[unknown]` frames mean missing symbols or frame pointers: build with debug info, keep frame pointers, or use a DWARF unwinder.
- Use the inverted ("bottom-up", "reverse") view to rank functions by self time across all callers.
- Compare two profiles with a differential view (`pprof -diff_base`, Firefox Profiler compare, `difffolded.pl` from FlameGraph) rather than eyeballing.

## Allocation and heap profiles

- **Allocation profile** (bytes or objects allocated, by stack): explains GC pressure and CPU spent allocating. Sort by allocated bytes; look for allocation in hot loops, repeated string building, per-call buffers, boxing.
- **Heap or retained profile** (live bytes at a point in time): explains RSS growth and leaks. Take two snapshots under the same workload, some time apart, and compare: the leak is what keeps growing. Follow the retainer path from the object to the GC root to see who holds it (caches without eviction, listeners never removed, closures capturing large scopes, global maps).
- Peak RSS can exceed the language heap (native buffers, mmap, allocator fragmentation). When the heap profile is flat but RSS grows, look at native memory (Bun's `heapStats().extraMemorySize`, `memray --native`, jemalloc or `heaptrack`).

## Turning a profile into a hypothesis

Name the frame, its share, and the mechanism you suspect, then predict the effect: "`JSON.parse` is 38% self time on the 2 MB payload; streaming the array should cut p95 by about a third." A prediction you can check is what makes the re-measure meaningful.
