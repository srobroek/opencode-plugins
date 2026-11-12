# Go runtime and application helpers

Prefer supported Go toolchains, simple builds and standard-library lifecycle/concurrency primitives.

Checked 2026-11-12. Standard-library entries use Go `1.27`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Supported runtime | Go `1.27` | Supported Go `1.26` for compatibility; libraries retain a supported required minimum | Unsupported toolchains or shipped binaries not rebuilt after security fixes. |
| Packaging/build | Go modules, `go.mod`, `go.sum`, native build tools; standard toolchain is sufficient | Project build orchestration for real multi-step needs | Dependency solely for a native toolchain capability. |
| Monorepos | Native `go.work`, modules and `internal/`; standard toolchain is sufficient | Existing repository orchestration | Multiple modules without an ownership/release boundary; workspace-only success mistaken for published-module correctness. |
| Containers | Pure-Go binary with `CGO_ENABLED=0`, digest-pinned nonroot distroless/static or Chainguard static | Compatible native-library/base image for CGO workloads | Static image for dynamically linked DuckDB/libvips binaries. |
| CPU/memory | Container-aware Go runtime plus explicit `GOMEMLIMIT`; standard runtime is sufficient | `go.uber.org/automaxprocs` `1` for older runtimes/compatibility configs | Automatic dependency on supported current runtimes; memory limit as hard RSS cap. |
| Shutdown | `signal.NotifyContext`, new bounded shutdown context and `http.Server.Shutdown`; standard library is sufficient | Explicit worker/connection drain hooks | Already-canceled signal context for shutdown; forgetting hijacked/WebSocket connections. |
| Binary releases | `github.com/goreleaser/goreleaser/v2` `2` when distributing binaries | `github.com/google/ko` `0.19` for straightforward Go container builds | Assuming a simple pure-Go container path covers arbitrary CGO/OS libraries. |
| Documentation | Go doc comments and executable examples; standard toolchain is sufficient | `golang.org/x/pkgsite` `0.6` for local browsing | Separate documentation generator without a named gap. |
| HTTP client | Shared `net/http.Client`/transport, explicit deadlines and body closure; standard library is sufficient | `github.com/hashicorp/go-retryablehttp` `0.7` for needed retries; `resty.dev/v3` `3` prerelease for evaluated REST ergonomics | Resty v3 described as stable; non-idempotent replay without safeguards. |
| Retry/backoff | SDK-native retries or bounded explicit policy | `github.com/cenkalti/backoff/v5` `5` for reusable backoff | Nested retries, no overall deadline/jitter or repeated side effects. |
| Circuit breaker | No breaker unless failure-isolation need exists | `github.com/sony/gobreaker/v2` `2` for a defined dependency policy | Universal breaker boilerplate; retry/breaker ordering left untested. |
| Rate limiting | `golang.org/x/time/rate` `0.16` for token buckets | `github.com/go-chi/httprate` `0.16` for HTTP limits; shared-store limiter for fleet quotas | Process-local quotas advertised as global. |
| Concurrency | `context`, channels, `sync`, `sync.WaitGroup.Go`; standard library is sufficient for simple coordination | `golang.org/x/sync/errgroup` `0.25` for cancellation/errors; `github.com/sourcegraph/conc` `0.3` for pool/result ergonomics | Unbounded goroutines; assuming WaitGroup propagates errors; calling conc abandoned solely from its tag. |
| Errors | `fmt` wrapping, `errors.Is`, `As`, `AsType`, `Join`; standard library is sufficient | `github.com/cockroachdb/errors` `1` for stack/redaction/diagnostic transport requirements | New `github.com/pkg/errors` `0.9` adoption without a gap; incorrect claims it is archived. |
| Date/time | `time`; standard library is sufficient | Domain-specific types for date-only/business calendars | Custom clock/date abstraction without a real domain/test need. |
| IDs | `uuid` v4/v7; standard library is sufficient in Go `1.27` | `github.com/google/uuid` `1` for older toolchains/existing types; `github.com/oklog/ulid/v2` `2` for ULID contracts | Sortable IDs as secrets or authorization. |
| Feature flags | `github.com/open-feature/go-sdk` `1` for applications/services/CLIs; flags.yaml: contrib `providers/flagd` `0.8`, `WithOfflineFilePath` (`.yaml`, `.yml`, `.json`) | SSM: contrib `providers/aws-ssm` `1.0`; AppConfig: third-party `github.com/Arthur1/openfeature-provider-go-aws-appconfig` `0.4`, Agent only, boolean flags, review dependency | Ask before writing a missing provider; libraries take caller decisions, OpenCode plugins keep options; see `quality-code-design`'s `feature-flags.md`. |
| Dependency injection | Manual constructor wiring; standard language features are sufficient | `go.uber.org/fx` `1` for lifecycle/container; `go.uber.org/dig` `1` for lower-level DI | New Google Wire adoption: archived and explicitly unmaintained. |
| State machines | Explicit states/transitions for small models; standard language features are sufficient | `github.com/looplab/fsm` `1` for event transitions; `github.com/qmuntal/stateless` `1` for hierarchical/guarded models | Framework machinery for a tiny switch. |
| Collections/helpers | `slices`, `maps`, `iter`, built-in collections; standard library is sufficient | `github.com/samber/lo` `1` for useful missing helpers | Blanket utility imports or bespoke collections without ordering/concurrency requirements. |
| Formatting/static tooling | Native formatter plus configured `golangci-lint` `2` | `mvdan.cc/gofumpt` `0.12` for stricter team style; `golang.org/x/tools/gopls` `0.24` for editor analysis | Obsolete lint config; commands duplicated from `lang-go-quality`. |

## Rules

- Recent standard-library features replace common dependencies:
  - Go `1.22`: method/wildcard routing.
  - Go `1.23`: iterators.
  - Go `1.24`: rooted filesystem and crypto additions.
  - Go `1.25`: stable synctest and WaitGroup helpers.
  - Go `1.26`: error helpers and modernizing fixes.
  - Go `1.27`: JSON v2 without experimental opt-in, and UUID v4/v7.
- Preserve existing wire contracts when changing codecs.
- Pin toolchains, runtime/native dependencies and build inputs. Test the actual deployment architecture/image, not only the developer host.
- Check module layout/build commands in `lang-go-packaging` and `lang-go-quality`; testing commands in `lang-go-testing`; benchmark methodology in `lang-go-profiling`.
- Use explicit lifecycle ownership and bounded drain/flush for HTTP, workers, connections and telemetry.

## Sources

- [Supported Go releases](https://go.dev/doc/devel/release), [Go 1.27](https://go.dev/doc/go1.27), [Go 1.25 runtime](https://go.dev/doc/go1.25#runtime), [memory limit](https://pkg.go.dev/runtime/debug#SetMemoryLimit), [workspaces](https://go.dev/doc/tutorial/workspaces).
- [Distroless](https://github.com/GoogleContainerTools/distroless), [Chainguard static](https://images.chainguard.dev/directory/image/static/overview), [GoReleaser](https://pkg.go.dev/github.com/goreleaser/goreleaser/v2), [ko](https://pkg.go.dev/github.com/google/ko), [doc comments](https://go.dev/doc/comment), [pkgsite](https://pkg.go.dev/golang.org/x/pkgsite).
- [HTTP client/shutdown](https://pkg.go.dev/net/http), [signals](https://pkg.go.dev/os/signal#NotifyContext), [retryablehttp](https://pkg.go.dev/github.com/hashicorp/go-retryablehttp), [Resty prerelease](https://pkg.go.dev/resty.dev/v3), [backoff](https://pkg.go.dev/github.com/cenkalti/backoff/v5), [breaker](https://pkg.go.dev/github.com/sony/gobreaker/v2), [rate](https://pkg.go.dev/golang.org/x/time/rate), [httprate](https://pkg.go.dev/github.com/go-chi/httprate).
- [errgroup](https://pkg.go.dev/golang.org/x/sync/errgroup), [conc](https://github.com/sourcegraph/conc), [errors](https://pkg.go.dev/errors), [UUID](https://pkg.go.dev/uuid), [ULID](https://pkg.go.dev/github.com/oklog/ulid/v2), [OpenFeature](https://pkg.go.dev/github.com/open-feature/go-sdk).
- [Wire archive](https://github.com/google/wire), [Fx](https://pkg.go.dev/go.uber.org/fx), [Dig](https://pkg.go.dev/go.uber.org/dig), [FSM](https://pkg.go.dev/github.com/looplab/fsm), [Stateless](https://pkg.go.dev/github.com/qmuntal/stateless), [collections](https://pkg.go.dev/slices), [lo](https://pkg.go.dev/github.com/samber/lo), [golangci](https://pkg.go.dev/github.com/golangci/golangci-lint/v2).
