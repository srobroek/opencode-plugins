---
name: go-quality
description: Use to run Go format, lint, and test checks with the project toolchain.
---

# Go Quality

Run the checks through the shell tool from the module root (the directory with
`go.mod`):

| Step | Command |
| --- | --- |
| Format check | `gofmt -l .` (lists unformatted files; any output is a failure) |
| Lint | `golangci-lint run` when installed, otherwise `go vet ./...` |
| Test | `go test ./...` |
| Format fix | `gofmt -w .` |

Narrow a run to the packages the task touched (`go test ./internal/foo/...`) when
the whole module is slow, and say so in the report.

In OpenCode, the built-in `gofmt` formatter rewrites each `.go` file after the
`edit`, `write` or `patch` tool changes it when `"formatter": true` is set in
`opencode.json`. Keep `gofmt -l` in the check for files changed any other way.

A missing `go.mod` or toolchain binary means that step did not run. Report it as
not run, never as a pass. Read failures as the project's actual toolchain output;
do not invent extra linters.
