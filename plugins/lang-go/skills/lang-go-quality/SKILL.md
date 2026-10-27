---
name: lang-go-quality
description: Use to run Go build, format, lint, vet, go mod tidy, govulncheck and go test -race checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
---

# Go Quality

Sources: `go help build`, `go help testflag`, `go help mod tidy`, `go help packages` (Go 1.27), [golangci-lint v2](https://golangci-lint.run/docs/), [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck), [race detector](https://go.dev/doc/articles/race_detector).

Run the checks through the shell tool from the module root (the directory with
`go.mod`), in this order. Stop at the first failing step, fix it, rerun that step,
then continue; later steps on code that does not build only add noise.

| Step | Command |
| --- | --- |
| Build | `go build ./...` |
| Format check | `golangci-lint fmt --diff` when `.golangci.yml` enables formatters, otherwise `gofmt -l .` (any output is a failure) |
| Lint | `golangci-lint run` when the project configures it, otherwise `go vet ./...` |
| Test | `go test -race ./...` |
| Module tidy | `go mod tidy -diff` (prints the diff and exits non-zero when `go.mod` or `go.sum` is stale) |
| Vulnerabilities | `govulncheck ./...` (or `go tool govulncheck ./...` when it is a `tool` in `go.mod`) |
| Format fix | `golangci-lint fmt`, or `gofmt -w .` |

- Respect the project's formatter. When `.golangci.yml` enables `gofumpt`,
  `goimports` or `gci`, a `gofmt`-only check passes code its CI rejects; when it
  uses plain `gofmt`, do not reformat with `gofumpt`.
- `-race` is the default for tests: it finds data races only on paths the tests
  run, and costs roughly 2-20× time and 5-10× memory. It needs cgo on Linux
  (`CGO_ENABLED=1` and a C compiler); when it cannot run, run `go test ./...` and
  report `-race` as not run.
- Narrow to the packages the task touched (`go test -race ./internal/billing/...`)
  when the module is slow, and say so in the report.
- In a `go.work` workspace, `./...` from a root without `go.mod` matches nothing.
  Use the `work` pattern (`go build work`, `go test -race work`, Go 1.25+) or run per
  module with `go -C ./svc test ./...`. `go mod tidy` is per module:
  `go -C ./svc mod tidy -diff`.
- Never `go install …@latest` a tool inside a check. Use the binary the project
  pins (a `tool` directive, Go 1.24+, run with `go tool <name>`) or what is on
  `PATH`, and report the step as not run if neither exists.

## CI

Run the same steps in the same order, one job or step per row so the failure is
named. Use `actions/setup-go` with `go-version-file: go.mod` (its module cache is on
by default), and install `golangci-lint` with `golangci/golangci-lint-action`, not
`go install`. Workflow structure, the required `ci-gate` job and action pinning are
the `toolchain` plugin's `ci-github-actions` skill.

In OpenCode, the built-in `gofmt` formatter rewrites each `.go` file after the
`edit`, `write` or `patch` tool changes it when `"formatter": true` is set in
`opencode.json`. Keep the format check for files changed any other way.

A missing `go.mod` or toolchain binary means that step did not run. Report it as
not run, never as a pass. Read failures as the project's actual toolchain output;
do not invent extra linters.
