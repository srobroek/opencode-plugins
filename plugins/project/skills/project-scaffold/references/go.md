# Go

Load `lang-go` (router) for quality, testing, packaging and profiling detail.

## Init

```sh
mise use go@latest                 # ask for the version; go.mod's `go` line is the floor
go mod init github.com/<owner>/<name>
```

One module first: `cmd/<binary>/main.go` (thin), shared code in `internal/`. Split into
several modules or a `go.work` only for separately released parts, and keep `go.work` out
of git (`lang-go-packaging`). Pin dev tools with `go get -tool <pkg>` and run them with
`go tool <name>`; never `go install ...@latest` in a check.

## Preferred tools and libraries

| Need | Pick |
| --- | --- |
| Base | standard library first |
| CLI | `urfave/cli` when plain `flag` is not enough |
| Config | `koanf` for layered configuration |
| Lint + format | `golangci-lint` v2: `.golangci.yml` with `version: "2"`, `linters.default: standard`, enable `errcheck govet ineffassign staticcheck unused` plus `gosec` (off in the standard set, so no security lint without it) and `revive` (its `exported` rule as a warning), `run.timeout: 5m`; formatters enabled; import layering with `depguard` rules |
| Tests | `go test -race ./...`; table tests, `httptest`, fuzzing (`lang-go-testing`) |
| Vulnerabilities | Project-pinned `go tool govulncheck ./...` (`go get -tool golang.org/x/vuln/cmd/govulncheck@<version>` during setup) |
| Dead code | Optional pinned `golang.org/x/tools/cmd/deadcode`: `go tool deadcode -test ./...` for executable/test roots; whole-program reachability complements `unused`/`staticcheck`, not a library API deletion list |
| Complexity | Optional golangci-lint v2 `gocyclo`/`gocognit`; start at 10-12/15 and ratchet reviewed exceptions |
| Vendoring | no `vendor/` unless the user wants it |

HTTP router, database access and logging: ask the user (sources are silent; `log/slog`
is the standard-library option to propose). Observability per `toolchain-quality-observability`.

## Gate (`just check`)

`go build ./...`, `golangci-lint fmt --diff`, `golangci-lint run`, `go test -race ./...`,
`go mod tidy -diff`, `go tool govulncheck ./...`. CI: `actions/setup-go` with
`go-version-file: go.mod` and `golangci/golangci-lint-action`.
