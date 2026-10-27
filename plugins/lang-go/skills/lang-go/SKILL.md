---
name: lang-go
description: "Use for Go work: go test, fuzzing, golangci-lint, govulncheck, modules, internal/, go.work, pprof or benchmarks."
---

# Go

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Running Go build, format, lint, vet, `go mod tidy`, govulncheck and test checks, locally or in CI | `lang-go-quality` |
| Writing or fixing Go tests: table tests, subtests, `-race`, golden files, fuzzing, httptest, synctest | `lang-go-testing` |
| Go module and package layout: monorepos, `cmd/`, `internal/`, `go.work`, build tags, depguard import rules | `lang-go-packaging` |
| Go profilers and benchmarks: pprof, `go test -bench`, benchstat | `lang-go-profiling` |

Go design (interfaces, errors, package responsibilities) is the `quality-code-design`
skill's `go.md` reference.
