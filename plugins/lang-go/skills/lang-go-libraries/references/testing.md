# Go testing libraries

Use the standard testing stack first and add specialized tools for the behavior being verified.
See `lang-go-testing`'s [practice reference](../../lang-go-testing/references/practice.md)
for Go idioms and tool choices; use `quality-testing` for suite design and maintenance.

Checked 2026-11-12. Standard-library entries use Go `1.27`; commands belong in `lang-go-testing` and `lang-go-quality`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Unit tests | `testing`, table tests and subtests; standard library is sufficient | `github.com/google/go-cmp` `0.7` for compound-value diffs; keep existing `github.com/stretchr/testify` `1` or `github.com/matryer/is` `1` assertions | A test framework solely to wrap basic checks; assertions that obscure useful failures. |
| Concurrent/time-dependent tests | `testing/synctest`; standard library is sufficient for supported in-process concurrency | Real infrastructure tests for sockets and external systems | Sleep-based synchronization; synctest as a replacement for network integration. |
| Property tests | `pgregory.net/rapid` `1` for domain generators/shrinking | Native fuzzing for parser/input boundaries | Random inputs without stated invariants or reproducible failures. |
| Fuzzing | Native Go fuzzing; standard library is sufficient | Specialized domain generators when byte mutations are inadequate | Third-party fuzz framework by habit; discarded failing seeds. |
| Snapshots/golden files | Explicit comparisons in `testdata`; standard library is sufficient | `gotest.tools/v3/golden` `3` or `github.com/sebdah/goldie/v2` `2` for update ergonomics | Automatic acceptance in CI or unreviewed bulk regeneration. |
| HTTP mocks | `net/http/httptest`, controlled servers and small fakes; standard library is sufficient | `github.com/dnaeon/go-vcr/v4` `4` for recordings against external APIs | Real internet in unit tests; credentials or PII in fixtures. |
| Interface mocks | Small consumer-owned fakes | `go.uber.org/mock` `0.6` for generated expectations; `github.com/vektra/mockery/v3` `3` for testify-oriented mocks | Archived `github.com/golang/mock`; implementation-detail expectations. |
| Factories/data | Explicit fixture functions and typed literals; standard library is sufficient | Rapid `1` generators for property testing | A global randomized factory hiding critical fields. |
| Database/broker integration | `github.com/testcontainers/testcontainers-go` `0.45` | Managed disposable test environment when container fidelity is insufficient | Driver mocks presented as proof of transactions, SQL or broker semantics. |
| AWS integration | Typed events and SDK-facing fakes for units | DynamoDB Local/LocalStack for selected behavior, followed by isolated cloud tests | Emulator-only claims about IAM, retries, batching and concurrency. |
| Consumer contracts | Ordinary schema/wire integration tests | `github.com/pact-foundation/pact-go/v2` `2` for independently deployed consumers/providers | Ignoring native `pact_ffi` installation/version requirements. |
| API schema/property checks | Tools selected by `toolchain-api` | `Schemathesis` `4` for schema-driven checks | Archived Dredd for new work; generated types presented as runtime validation. |
| HTTP load | `github.com/tsenart/vegeta/v12` `12` for rate tests | `k6` CLI `2` for scripted scenarios/protocol breadth | A single throughput number as realistic capacity; k6 Go-module `1` confused with checked CLI `2`. |
| Mutation | Optional `github.com/go-gremlins/gremlins` `0.6` pilot on critical code | Compatible evaluated alternative fork for unsupported syntax | Whole-project mutation as an unconditional PR gate; stale original go-mutesting snapshots. |
| Benchmarks | `testing.B` with `b.Loop` on Go `1.24`+, allocation reports and profiles | Project comparison tooling selected by `lang-go-profiling` for repeated runs | Mixing `b.Loop` with `b.N`; one noisy run as proof of system performance. |
| Coverage | Native Go coverage and changed-code review; standard library is sufficient | Existing coverage aggregation for multiple modules | Universal percentages presented as proof of behavioral coverage. |
| CI reporting/flakes | `go test`, shuffle/repeat diagnosis; optional `gotest.tools/gotestsum` `1` artifacts | Explicit diagnostic reruns preserving initial failures | `--rerun-fails` silently turning intermittent defects green. |
| Telemetry | OTel SDK `1` in-memory trace facilities and signal readers | Real collector/backend smoke test for export wiring | Random ID/time assertions or missing failure/secret checks. |

## Rules

- Test business invariants directly; test adapters, middleware order, early exits, cancellation and streaming separately.
- Preserve first-attempt failure evidence. Retries diagnose flakes rather than erase them; quarantines need ownership and expiry.
- Bound normal-CI fuzz/load work. Run longer campaigns separately. Keep fixtures reviewed and secret-free.
- Check native dependencies and current Go syntax support before adopting contract or mutation tools.

## Sources

- [testing](https://pkg.go.dev/testing), [synctest](https://pkg.go.dev/testing/synctest), [httptest](https://pkg.go.dev/net/http/httptest), [fuzzing](https://go.dev/doc/security/fuzz/), [go-cmp](https://pkg.go.dev/github.com/google/go-cmp), [Rapid](https://pkg.go.dev/pgregory.net/rapid).
- [Golden helpers](https://pkg.go.dev/gotest.tools/v3/golden), [Goldie](https://pkg.go.dev/github.com/sebdah/goldie/v2), [recordings](https://pkg.go.dev/github.com/dnaeon/go-vcr/v4), [Uber mocks](https://pkg.go.dev/go.uber.org/mock), [Mockery](https://pkg.go.dev/github.com/vektra/mockery/v3), [Testcontainers](https://pkg.go.dev/github.com/testcontainers/testcontainers-go).
- [Pact](https://pkg.go.dev/github.com/pact-foundation/pact-go/v2), [Schemathesis](https://github.com/schemathesis/schemathesis), [Vegeta](https://pkg.go.dev/github.com/tsenart/vegeta/v12), [k6 CLI](https://github.com/grafana/k6/releases), [Gremlins](https://pkg.go.dev/github.com/go-gremlins/gremlins), [benchstat](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat), [telemetry tests](https://pkg.go.dev/go.opentelemetry.io/otel/sdk/trace/tracetest).
