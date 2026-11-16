# Go quality tools

Linters, analyzers and audits for Go. Security controls and secret, SBOM, licence, container and workflow scanners are in [security.md](security.md); testing concerns are in [testing.md](testing.md).

Checked 2026-11-16.

Commands belong in `lang-go-quality`. Install policy: detect the tool, recommend the install, ask before running it (`concerns.md` in `toolchain-languages`). Prefer a `tool` directive in `go.mod` (Go 1.24+, `go get -tool`, run with `go tool <name>`); the Maintenance cell is a minimum, so use the latest release. Shared tools: `shared-tools.md` in `toolchain-languages`.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lint` | `golangci-lint` | >= 2.15.0 · 2026-10-16 · active | `golangci-lint --version` · `brew install golangci-lint` | staticcheck: standalone run without a config | `golangci-lint` bundles staticcheck, revive, errcheck and the linters below; run one binary | every-pr | Two linters with overlapping rules as separate gates; GPL-3.0 tool licence is fine to run but check redistribution |
| `format` | Built-in: `gofmt` | - | Built-in | golangci-lint fmt (gofumpt, gci): the project's `.golangci.yml` enables formatters | - | every-pr | A `gofmt`-only check on a project whose CI enforces gofumpt or gci |
| `types` | Built-in: `go vet` | - | Built-in | staticcheck: deeper checks, normally through golangci-lint | `go vet` plus staticcheck on every PR | every-pr | `go vet` alone presented as the lint gate |
| `sast` | `golangci-lint` with `gosec` enabled | >= 2.15.0 · 2026-10-16 · active | `golangci-lint --version` · `brew install golangci-lint` | semgrep: custom rules, shared with other languages; opengrep: same rule format without the vendor rule licence; codeql: data-flow depth in CI | gosec for fast local feedback; add codeql in CI where the repository is eligible | every-pr | Scanner output as a complete audit; ignoring rule licences |
| `memory-safety` | Built-in: `-race`; `-asan` and `-msan` for cgo | - | Built-in | None | `-race` on Go tests; `-asan` or `-msan` when cgo or unsafe code is involved | every-pr | `-race` as proof of no races on paths no test runs; sanitizers on pure-Go code with no cgo |
| `dep-audit` | `govulncheck` | >= 1.9.0 · 2026-10-11 · active | `grep -F golang.org/x/vuln go.mod` · `go get -tool golang.org/x/vuln/cmd/govulncheck@latest` | osv-scanner: polyglot repositories with several lockfiles | govulncheck for reachable Go vulnerabilities and osv-scanner for the non-Go manifests | every-pr + scheduled | osv-scanner as the only Go gate, since it ignores reachability |
| `dead-code` | `deadcode` | >= 0.52.0 · 2026-10-10 · active | `grep -F golang.org/x/tools/cmd/deadcode go.mod` · `go get -tool golang.org/x/tools/cmd/deadcode@latest` | unused (golangci-lint): per-declaration, no whole-program view | `unused` in the lint run and `deadcode -test` on executables | on-demand | Deleting exported library API because one executable does not reach it |
| `unused-deps` | Built-in: `go mod tidy -diff` | - | Built-in | None | - | every-pr | Running `go mod tidy` without `-diff` in CI, which rewrites files |
| `complexity` | `golangci-lint` with `gocognit` at 15 | >= 2.15.0 · 2026-10-16 · active | `golangci-lint --version` · `brew install golangci-lint` | gocyclo: cyclomatic limit of 10-12 beside it; lizard: one metric across languages | gocognit and gocyclo together, ratcheted against a baseline | every-pr | Arbitrary limits as defects; exceptions without an owner |
| `duplication` | `golangci-lint` with `dupl` | >= 2.15.0 · 2026-10-16 · active | `golangci-lint --version` · `brew install golangci-lint` | jscpd: one report across languages | - | every-pr | Gating generated-code duplication; overlapping duplication gates |
| `api-break` | `go-apidiff` | >= 0.8.3 · 2025-05-22 · active | `grep -F joelanford/go-apidiff go.mod` · `go get -tool github.com/joelanford/go-apidiff@latest` | oasdiff: HTTP API contracts | go-apidiff on PRs and at release; it builds on `golang.org/x/exp/apidiff` | every-pr + release | `gorelease` (needs tags, slower); reporting an internal package as public |
| `docs` | Built-in: `go doc`, doc comments and `Example` functions | - | Built-in | pkgsite: browse rendered docs locally; godoclint: lint doc comments beside revive exported | Built-in docs with revive and godoclint through golangci-lint | every-pr | gomarkdoc and godocdown, which are stale; Example functions without `// Output:` |

## Tradeoffs

### lint

- **golangci-lint**: wins as one runner with one config and many linters; costs a GPL-3.0 tool licence and a config that drifts between major versions.
- **staticcheck**: wins for a quick standalone check; costs separate runs for every other linter.

### sast

- **golangci-lint**: wins when gosec runs inside the lint binary you already use, with one config and fast local feedback; costs gosec's pattern-level heuristics with no data-flow analysis.
- **semgrep**: wins when custom rules are shared with other languages; costs a restrictive licence on Semgrep-maintained rules.
- **opengrep**: wins for the same rule format with no vendor rule licence; costs a younger project.
- **codeql**: wins for data-flow analysis in CI; costs a build step and a slower run.

### complexity

- **golangci-lint**: wins when gocognit, gocyclo and the rest run in the one lint pass with a shared baseline; costs the golangci-lint config upkeep and a cognitive metric only as good as its threshold.
- **gocyclo**: wins as a second, cyclomatic limit of 10-12 beside gocognit; costs overlapping findings.
- **lizard**: wins for one metric across languages; costs a Python tool outside the Go toolchain.

### api-break

- **oasdiff**: wins for HTTP API contracts in OpenAPI files; costs no Go symbol analysis.

### docs

- **pkgsite**: wins for previewing rendered docs locally; costs a local server and no lint.
- **godoclint**: wins for doc-comment style rules in golangci-lint; costs a young linter that overlaps revive `exported`.

## Language-specific

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Cognitive complexity limit | `gocognit` at 15 in golangci-lint | The project already sets a different reviewed limit | Reporting only above 30, golangci-lint's own default. |
| Licence inventory | `go-licenses` for dependency licences | Organization-approved compliance tooling | Repository licence read as dependency compliance. |

## Sources

- [golangci-lint](https://golangci-lint.run/docs/), [linters](https://golangci-lint.run/docs/linters/), [staticcheck](https://staticcheck.dev/), [gosec](https://pkg.go.dev/github.com/securego/gosec/v2).
- [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck), [deadcode](https://pkg.go.dev/golang.org/x/tools/cmd/deadcode), [go mod tidy](https://go.dev/ref/mod#go-mod-tidy), [race detector and sanitizers](https://go.dev/doc/articles/race_detector).
- [go-apidiff](https://github.com/joelanford/go-apidiff), [apidiff](https://pkg.go.dev/golang.org/x/exp/apidiff), [pkgsite](https://pkg.go.dev/golang.org/x/pkgsite/cmd/pkgsite), [godoclint](https://github.com/godoc-lint/godoc-lint), [revive](https://github.com/mgechev/revive), [doc comments](https://go.dev/doc/comment).
