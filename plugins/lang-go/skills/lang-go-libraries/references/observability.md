# Go observability

Use structured logging and explicit OpenTelemetry instrumentation with portable OTLP export.

Checked 2026-11-12. Standard-library entries use Go `1.27`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Service logging | `log/slog` with `JSONHandler`; standard library is sufficient | `github.com/lmittmann/tint` `1` for development; existing `go.uber.org/zap` `1` or `github.com/rs/zerolog` `1` integrations or measured needs | Replacing the logger without a concrete benefit; plaintext-only production logs and secrets. |
| Local trace correlation | Context-aware slog calls and a handler that adds active `trace_id`/`span_id` | `go.opentelemetry.io/contrib/bridges/otelslog` `0.21` for exporting OTel logs | Assuming a separate `JSONHandler` gains correlation from the OTel bridge automatically. |
| SDK | `go.opentelemetry.io/otel` `1`, SDK providers initialized at process entry | Existing approved OTel bootstrap package | SDK initialization per request; global providers in isolated tests. |
| OTLP export | `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp` `1` and `otlpmetric/otlpmetrichttp` `1` under the same exporter prefix, explicit `http/protobuf` to Collector | OTLP gRPC for deployment constraints; `go.opentelemetry.io/contrib/exporters/autoexport` `0.72` for environment-selected exporters | Hard-coded vendor-only pipeline; assuming every SDK environment variable is implemented. |
| HTTP | `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` `0.72` around handler and shared client transport | Existing framework instrumentation with verified equivalent coverage | Double spans; wrappers that lose flushing/hijacking support. |
| gRPC | `go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc` `0.72` stats handlers | Connect interceptors using the matching installed API | Unverified interceptor signatures copied from a different major. |
| AWS calls | `go.opentelemetry.io/contrib/instrumentation/github.com/aws/aws-sdk-go-v2/otelaws` `0.72` with SDK v2 | Existing approved equivalent instrumentation | Two tracing SDKs patching the same client. |
| SQL | `github.com/exaring/otelpgx` `0.13` for pgx; `github.com/XSAM/otelsql` `0.44` for standard SQL | Existing database instrumentation with equivalent coverage | Sensitive SQL parameters or duplicate DB spans. |
| Metrics | OTel metrics API/SDK `1` in an OTel stack | `github.com/prometheus/client_golang` `1` for Prometheus-native scrape services | Duplicate business metrics across APIs; unbounded labels. |
| Automatic instrumentation | Explicit source instrumentation | `go.opentelemetry.io/auto` `0.24` for evaluated Linux amd64/arm64 tracing deployments | Treating a work-in-progress eBPF implementation as portable full-signal coverage. |
| Telemetry tests | `go.opentelemetry.io/otel/sdk/trace/tracetest` `1`, isolated providers | SDK metric readers/log exporters for their corresponding signals | Assertions on random IDs/timestamps, real collectors in every unit test, or no flush. |

## Signal status

The Go SDK repository and checked core `1.47` documentation call traces, metrics and logs stable. The shared language-status page still calls Go logs release candidate. Prefer the installed SDK's versioned guarantees. Re-check this discrepancy before adopting log export. Contrib bridge/instrumentation `0.x` lines have separate guarantees. Go profile support needs a separate check because the shared page leaves its status unspecified.

## Rules

- Set `service.name`, `service.version` and `deployment.environment.name`; configure sampling and propagation explicitly. Allowlist baggage.
- Use batching in production and bounded flush/shutdown at service or CLI exit. Lambda needs invocation-end flushing, not provider shutdown per invocation; see `aws.md`.
- Use route/operation span names, bounded metric dimensions and meaningful business spans. Record errors once and set error status according to protocol semantics.
- Pin convention and instrumentation versions. Messaging, GenAI and MCP conventions remain development; stable core APIs do not stabilize every attribute.
- Structured stdout plus platform collection is sufficient when OTLP logs are not an intentional requirement. Do not ship the same logs twice.
- Test names, kinds, parentage, propagation, attributes, failure status, cardinality and absence of secrets.
- Use `quality-code-design` and `telemetry.md` for the shared telemetry checklist, and `middleware.md` for composition rules.

## Sources

- [slog](https://pkg.go.dev/log/slog), [tint](https://pkg.go.dev/github.com/lmittmann/tint), [otelslog](https://pkg.go.dev/go.opentelemetry.io/contrib/bridges/otelslog).
- [Core status](https://github.com/open-telemetry/opentelemetry-go#project-status), [shared status](https://opentelemetry.io/docs/languages/), [core module](https://pkg.go.dev/go.opentelemetry.io/otel), [exporters](https://github.com/open-telemetry/opentelemetry-go/tree/main/exporters/otlp), [autoexport](https://pkg.go.dev/go.opentelemetry.io/contrib/exporters/autoexport).
- [Contrib instrumentation](https://github.com/open-telemetry/opentelemetry-go-contrib), [otelpgx](https://pkg.go.dev/github.com/exaring/otelpgx), [otelsql](https://pkg.go.dev/github.com/XSAM/otelsql), [automatic instrumentation status](https://github.com/open-telemetry/opentelemetry-go-instrumentation#readme).
- [Prometheus](https://pkg.go.dev/github.com/prometheus/client_golang), [trace test facilities](https://pkg.go.dev/go.opentelemetry.io/otel/sdk/trace/tracetest), [SDK environment configuration](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/), [sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/).
