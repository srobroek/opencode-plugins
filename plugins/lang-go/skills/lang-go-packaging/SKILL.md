---
name: lang-go-packaging
description: Use for Go module and package layout (monorepo, cmd/, internal/, go.work, build tags, tool directive, depguard).
metadata:
  opencode/autoinvoke: false
---

# Go Packaging

Sources: [Organizing a Go module](https://go.dev/doc/modules/layout), [Go modules reference: workspaces](https://go.dev/ref/mod#workspaces), `go help buildconstraint`, `go help packages` (Go 1.27), [golangci-lint depguard](https://golangci-lint.run/docs/linters/configuration/#depguard).

Package design (consumer-owned interfaces, no `utils` package) is the `quality-code-design`
skill's `go.md` reference. This skill is the module mechanics.

## One module first

```text
go.mod                 module example.com/shop
cmd/api/main.go        one directory per binary; main stays thin
cmd/worker/main.go
internal/billing/      shared by both binaries, importable by nothing outside the module tree
internal/storage/
```

- A monorepo whose services ship together is one module: shared code under
  `internal/`, binaries under `cmd/<name>`. One `go.mod`, one dependency graph, one
  `go test ./...`.
- `internal/` is enforced by the go tool: `a/b/internal/c` is importable only by
  code rooted at `a/b`. Put code there by default; move it out only when another
  repository must import it, because everything outside `internal/` is public API.
- The compiler rejects import cycles. A cycle means two packages share a concept;
  move it to a third package both import, or merge them.
- Split into several modules only when parts are versioned and released
  separately (a public client library, a tool with different dependencies). Each
  extra module adds its own `go.mod`, tags (`sub/v1.2.0`) and tidy step.
- A module at major version 2 or later has the `/v2` suffix in its module path and
  in every import.

## go.work for local multi-module development

```sh
go work init ./api ./client      # writes go.work with use directives
go work use ./tools              # add another module
GOWORK=off go test ./...         # check one module against its own go.mod only
```

`go.work` makes local modules override each other's required versions. The Go
modules reference calls committing `go.work` generally inadvisable: CI would build
against the local versions, not what each `go.mod` requires. Keep it out of version
control (or, for a deliberately committed workspace, still run `GOWORK=off` per module
in CI). From a workspace root without `go.mod`, `./...` matches nothing: use the `work`
pattern (`go test work`, Go 1.25+) or `go -C ./api test ./...`.

## Tools pinned in go.mod

```sh
go get -tool golang.org/x/tools/cmd/stringer   # Go 1.24+: records a tool directive
go tool stringer -type=State                   # runs the pinned version
```

This replaces the old `tools.go` blank-import file and keeps generators and linters at
the version `go.mod` records.

## Build tags for debug-only code

```go
// debug_on.go
//go:build debug

package app

const debugEnabled = true
```

```go
// debug_off.go
//go:build !debug

package app

const debugEnabled = false
```

`if debugEnabled { … }` is removed from builds without `-tags debug`, and files tagged
`debug` (debug endpoints, extra assertions) are not compiled at all. The constraint
line comes before `package`, followed by a blank line. Vet and test both variants:
`go vet ./...` and `go vet -tags debug ./...`.

## Import rules with depguard

Enforce layering in CI instead of in review, with golangci-lint v2:

```yaml
# .golangci.yml
version: "2"
linters:
  enable: [depguard]
  settings:
    depguard:
      rules:
        domain:
          files: ["**/internal/domain/**"]
          deny:
            - pkg: "database/sql"
              desc: the domain uses the repository interface; SQL lives in internal/storage
            - pkg: "net/http"
              desc: transport belongs in internal/httpapi
```

Each rule names the files it applies to and the packages they may not import
(`desc` is the message). `files` globs match the full path: `**/internal/domain/**`
matches, `**/internal/domain/**/*.go` silently matches nothing, so prove a new rule by
adding a forbidden import and watching it fail. Enabling depguard with no rules allows
only the standard library everywhere, so always define rules.

A `go.work` in a parent directory also captures the module: when `go` or
golangci-lint reports `directory prefix . does not contain modules listed in go.work`,
run with `GOWORK=off`.
