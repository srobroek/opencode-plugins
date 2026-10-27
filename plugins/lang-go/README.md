# lang-go

Go skills: the build, lint, test, tidy and vulnerability checks to run through the shell
tool and in CI, how to report a step that could not run, testing and fuzzing idioms,
module and package layout, and the profiler and benchmark tooling.
Formatting is OpenCode's built-in formatter (`"formatter": true`); see
[docs/formatters.md](../../docs/formatters.md).

Replaces the Go half of the former `languages` plugin, which ported the omp-plugins `go`
plugin (its `go_quality` tool is not ported).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/lang-go'
```

Claude Code and Codex install the same skills from this repository's marketplace:

```sh
claude plugin install lang-go@srobroek-opencode
codex plugin add lang-go@srobroek-opencode
```

## Skills

Only `lang-go` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.
The profiling skill is also reached through the `quality` plugin's `quality-profiling` skill.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `lang-go`: the router.
- `lang-go-quality`: `go build`, `golangci-lint fmt --diff` or `gofmt -l`, `golangci-lint run`
  or `go vet`, `go test -race`, `go mod tidy -diff`, `govulncheck`, in that order, and CI.
- `lang-go-testing`: table tests and subtests, go-cmp, golden files, fuzzing, httptest,
  `testing/synctest`.
- `lang-go-packaging`: one module with `cmd/` and `internal/`, `go.work`, `tool`
  directives, build tags for debug code, depguard import rules.
- `lang-go-profiling`: pprof, `go test -bench`, `go tool trace`, benchstat. The method is
  the `quality` plugin's `quality-profiling` skill.
