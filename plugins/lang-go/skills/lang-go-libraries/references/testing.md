# Go testing libraries

Use the standard testing stack first and add specialized tools for the behavior being verified.
See `lang-go-testing`'s [practice reference](../../lang-go-testing/references/practice.md)
for Go idioms and tool choices; use `quality-testing` for suite design and maintenance.

Checked 2026-11-16.

Standard-library entries use Go `1.27`; commands belong in `lang-go-testing` and `lang-go-quality`. Install policy: detect the tool, recommend the install, ask before running it (`toolchain-languages` `concerns.md`). Shared tools: `shared-tools.md` in `toolchain-languages`.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | Built-in: `go test` | - | Built-in | gotestsum: JUnit XML and readable output for CI | `go test` produces the results; gotestsum wraps it when CI needs JUnit | every-pr | `--rerun-fails` as a gate; it hides intermittent defects |
| `assertions` | Built-in: `testing` package plus `github.com/google/go-cmp` (`cmp.Diff`) as the one diff helper | >= 0.7.0 · 2025-02-21 · active | `grep google/go-cmp go.mod` · `go get github.com/google/go-cmp@latest` | testify 1.12.1 (2026-08-19) or matryer/is: the project already uses it, so keep it | - | every-pr | Ginkgo/Gomega in new code (DSL, not plain tests); mixing two assertion libraries |
| `watch` | `gotestsum --watch` (Apache-2.0) | >= 1.13.0 · 2025-09-11 · active | `gotestsum --version` · `go install gotest.tools/gotestsum@latest` | watchexec 2.8.0: language-agnostic watching | Built-in `go test` caching for test selection | on-demand | Watching with `-count=1`, which defeats cache-based selection |
| `property` | `pgregory.net/rapid` | >= 1.3.0 · 2026-04-30 · active | `grep pgregory.net/rapid go.mod` · `go get pgregory.net/rapid@latest` | gopter: existing suites only; testing/quick: frozen, trivial checks only | - | every-pr | Random inputs without a stated invariant; keeping failing seeds out of the repository |
| `fuzz` | Built-in: `go test -fuzz` | - | Built-in | None | - | bounded-pr | Unbounded `-fuzztime` on a PR; discarding `testdata/fuzz` failures |
| `fuzz-continuous` | Shared: oss-fuzz | - | Shared | clusterfuzzlite: private repositories or PR-time campaigns | oss-fuzz for the long campaign and clusterfuzzlite for the PR when both are eligible | scheduled | Fuzz targets that are not built with `compile_native_go_fuzzer` |
| `mutation` | `gremlins` | >= 0.6.0 · 2025-12-06 · pre-1.0 | `grep -F go-gremlins/gremlins go.mod` · `go get -tool github.com/go-gremlins/gremlins/cmd/gremlins@latest` | go-mutesting (avito-tech v2): gremlins cannot parse the code | - | diff-pr + scheduled | Whole-module mutation as a blocking PR gate; assuming Go 1.27 generic-method syntax is supported (unverified) |
| `snapshot` | Built-in: golden files in `testdata` | - | Built-in | gotest.tools/v3/golden: update flag and diff helper; goldie: template and fixture-dir helpers | - | every-pr | Automatic update in CI; unreviewed bulk regeneration |
| `component` | N/A: no UI component model | - | - | None | - | every-pr | - |
| `concurrency` | Built-in: `-race` and `testing/synctest` | - | Built-in | goleak: assert no goroutine outlives a test; goroutineleak profile: with Go 1.27 runtime/pprof, inspect leaks in a running process | `-race`, `synctest` and goleak together on concurrent code | every-pr | Sleep-based synchronization; synctest as a substitute for network integration |
| `coverage` | Built-in: `go test -coverprofile` | - | Built-in | None | - | every-pr | A percentage target; statement coverage read as branch coverage |
| `benchmark` | Built-in: `testing.B` with `b.Loop` | - | Built-in | benchstat: compare repeated runs | `go test -bench -count=10` output goes through benchstat before any claim | on-demand | One noisy run as proof; mixing `b.Loop` with `b.N` |
| `flaky-order` | Built-in: `-shuffle=on -count=N` | - | Built-in | gotestsum: `--rerun-fails` for diagnosis only | - | scheduled | Retries on by default; quarantine without an owner and expiry |
| `integration` | Shared: testcontainers | - | Shared | None | - | every-pr | Driver mocks presented as proof of SQL, transaction or broker behaviour |
| `contract` | Shared: contracts | - | Shared | pact-go 2.9.0: two or more services you own call each other and deploy independently (Pact Broker required, and the native pact_ffi install) | - | every-pr | Pact as the only gate for public APIs; skipping the native `pact_ffi` install that pact-go 2 needs |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr + scheduled | Running against production; archived Dredd |
| `load` | Shared: k6 | - | Shared | vegeta: constant-rate HTTP attacks from Go code or the CLI, with no AGPL-3.0 licence to weigh | - | scheduled | One throughput number as capacity |

## Tradeoffs

### property

- **pgregory.net/rapid**: wins on automatic shrinking, stateful testing and `go test` integration with saved failing seeds; costs a dependency and generators to learn.
- **gopter**: wins when a suite already uses it; costs no release since 2020.
- **testing/quick**: wins for a one-line check with no dependency; costs a frozen package with no shrinking.

### snapshot

- **gotest.tools/v3/golden**: wins when the project already uses gotest.tools and wants a `-test.update-golden` flag; costs a dependency and a fixed file layout.
- **goldie**: wins for templated or per-directory fixtures; costs a dependency and its own update flag.

### concurrency

- **goleak**: wins when a test must fail on a leaked goroutine; costs a dependency and noise from background goroutines that need ignore options.
- **goroutineleak profile**: wins for leaks in a live service via `runtime/pprof`; costs a profile read by hand rather than a test assertion.

## Language-specific

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Unit tests | `testing`, table tests and subtests; standard library is sufficient | Assertions: see the `assertions` row | A test framework solely to wrap basic checks. |
| HTTP mocks | `net/http/httptest`, controlled servers and small fakes; standard library is sufficient | `github.com/dnaeon/go-vcr/v4` for recordings against external APIs | Real internet in unit tests; credentials or PII in fixtures. |
| Interface mocks | Small consumer-owned fakes | `go.uber.org/mock` for generated expectations; `github.com/vektra/mockery/v3` for testify-oriented mocks | Archived `github.com/golang/mock`; implementation-detail expectations. |
| Factories/data | Explicit fixture functions and typed literals; standard library is sufficient | Rapid generators for property testing | A global randomized factory hiding critical fields. |
| AWS integration | Typed events and SDK-facing fakes for units | DynamoDB Local or LocalStack for selected behaviour, then isolated cloud tests | Emulator-only claims about IAM, retries, batching and concurrency. |
| Telemetry | OTel SDK in-memory trace facilities and signal readers | Real collector or backend smoke test for export wiring | Random ID or time assertions; missing failure and secret checks. |

## Rules

- Test business invariants directly; test adapters, middleware order, early exits, cancellation and streaming separately.
- Preserve first-attempt failure evidence. Retries diagnose flakes rather than erase them; quarantines need ownership and expiry.
- Bound normal-CI fuzz and load work. Run longer campaigns separately. Keep fixtures reviewed and secret-free.
- Mutation: scope with `gremlins unleash --diff <ref> --output=<json>`. Neither Gremlins nor go-mutesting emits the Stryker schema; `quality_test_compare` reads the Gremlins JSON.

## Sources

- [testing](https://pkg.go.dev/testing), [synctest](https://pkg.go.dev/testing/synctest), [httptest](https://pkg.go.dev/net/http/httptest), [fuzzing](https://go.dev/doc/security/fuzz/), [go-cmp](https://pkg.go.dev/github.com/google/go-cmp), [Rapid](https://pkg.go.dev/pgregory.net/rapid).
- [Golden helpers](https://pkg.go.dev/gotest.tools/v3/golden), [Goldie](https://pkg.go.dev/github.com/sebdah/goldie/v2), [recordings](https://pkg.go.dev/github.com/dnaeon/go-vcr/v4), [Uber mocks](https://pkg.go.dev/go.uber.org/mock), [Mockery](https://pkg.go.dev/github.com/vektra/mockery/v3), [Testcontainers](https://pkg.go.dev/github.com/testcontainers/testcontainers-go).
- [Pact](https://pkg.go.dev/github.com/pact-foundation/pact-go/v2), [Schemathesis](https://github.com/schemathesis/schemathesis), [Vegeta](https://pkg.go.dev/github.com/tsenart/vegeta/v12), [k6 CLI](https://github.com/grafana/k6/releases), [Gremlins](https://pkg.go.dev/github.com/go-gremlins/gremlins), [go-mutesting](https://github.com/avito-tech/go-mutesting), [goleak](https://pkg.go.dev/go.uber.org/goleak), [runtime/pprof](https://pkg.go.dev/runtime/pprof), [benchstat](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat), [telemetry tests](https://pkg.go.dev/go.opentelemetry.io/otel/sdk/trace/tracetest).
