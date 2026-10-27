---
name: language-quality
description: "Use to run Go, Python or TypeScript/JavaScript format, lint, type-check and tests, or for TS exhaustive unions."
---

# Language quality

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Go format, lint and test checks | `go-quality` |
| Python format, lint, type-check and test commands | `python-quality` |
| TypeScript/JavaScript format, lint and type-check; exhaustive unions; trust-boundary validation | `typescript-quality` |
| Go profilers and benchmarks: pprof, `go test -bench`, benchstat | `lang-go-profiling` |
| Python profilers and benchmarks: py-spy, scalene, memray, cProfile | `lang-python-profiling` |
| Bun or Node profilers and benchmarks: `--cpu-prof`, heap profiles, mitata | `lang-typescript-profiling` |
