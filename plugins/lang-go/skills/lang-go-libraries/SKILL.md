---
name: lang-go-libraries
description: Compare Go libraries before writing code for web, data, AWS, messaging, telemetry, CLI, testing or security.
metadata:
  opencode/autoinvoke: false
---

# Go libraries

Checked 2026-11-12.

## How to use

- Keep the project's existing choice unless the task is a migration. Apply the reuse order: existing code, standard library, framework features, listed dependency.
- Otherwise use the default below. An alternative needs its listed condition. A departure from both needs a named gap; report the choice and reason.
- Read the relevant reference before designing or writing code. The defaults are recommendations with conditions for alternatives.
- Re-check fast-moving rows, especially MCP, LLM SDKs and OpenTelemetry, on the registry before adding them. Pin the exact version added; these tables name major or minor lines.
- A dependency the request did not name needs approval, even when this guide lists it. Do not add unused parts of this stack.
- Use `toolchain-api` for API style, contracts and API test tools. Use `quality-code-design` and its `middleware.md` and `telemetry.md` references for shared design rules.
- Use `lang-go-quality` and `lang-go-testing` for commands. Use `aws-guidance` for Lambda and AWS deployment decisions.

## Default stack

Standard-library entries below use Go `1.27`; retain a supported lower minimum when the project requires it.

| Concern | Default | Notes |
| --- | --- | --- |
| Runtime | Go `1.27` | `1.26` remains a supported compatibility line. |
| HTTP server and router | `net/http`, `http.ServeMux` | Standard library is sufficient for ordinary method/path routing. |
| Middleware | `func(http.Handler) http.Handler` | Use framework middleware for cross-cutting concerns, not repeated handler code. |
| Request validation | Explicit domain checks; `github.com/go-playground/validator/v10` `10` for tags | Standard library suffices for small boundary types. |
| OpenAPI | `github.com/oapi-codegen/oapi-codegen/v2` `2` | Schema-first; `github.com/danielgtaylor/huma/v2` `2` for code-first. |
| RPC | `connectrpc.com/connect/v2` `2` | `google.golang.org/grpc` `1` for established gRPC infrastructure. |
| GraphQL | `github.com/99designs/gqlgen` `0.17` | Only when graph-shaped client needs justify it. |
| Streaming | `net/http` SSE | Standard library suffices for one-way notifications. |
| JSON | `encoding/json` | Preserve existing wire semantics; JSON v2 is available in Go `1.27`. |
| PostgreSQL | `github.com/jackc/pgx/v5` `5` | Its pool plus generated SQL. |
| SQL generation | `github.com/sqlc-dev/sqlc` `1` | Keep SQL explicit. |
| Migrations | `github.com/pressly/goose/v3` `3` | SQL migrations; do not migrate on every request. |
| Valkey | `github.com/valkey-io/valkey-go` `1` | Redis integrations may retain `github.com/redis/go-redis/v9` `9`. |
| Local cache | `sync.Map` or locked map | Standard library suffices when eviction is unnecessary. |
| Background jobs | `github.com/riverqueue/river` `0.51` | PostgreSQL-backed durable jobs. |
| Workflows | `go.temporal.io/sdk` `1` | Only for durable orchestration. |
| Kafka | `github.com/twmb/franz-go` `1` | Pure-Go client; AWS IAM signer for MSK. |
| Logging | `log/slog` JSON handler | Standard library suffices; enrich from request context. |
| Telemetry | `go.opentelemetry.io/otel` `1` over OTLP | Explicit SDK bootstrap and bounded shutdown. |
| HTTP instrumentation | `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` `0.72` | Instrument server and shared client transport. |
| HTTP client | `net/http.Client` | Standard library suffices with shared transport and time budgets. |
| AWS | `github.com/aws/aws-sdk-go-v2` `1` | SDK product generation is v2; root module major is `1`. |
| Lambda | `github.com/aws/aws-lambda-go` `1` | Thin adapters; no official Go Powertools. |
| MCP | `github.com/modelcontextprotocol/go-sdk` `1` | Official SDK; verify protocol compatibility. |
| LLM calls | Provider SDK | `github.com/openai/openai-go/v3` `3` or `github.com/anthropics/anthropic-sdk-go/v2` `2`. |
| CLI | `flag` | Standard library suffices for small tools; `github.com/spf13/cobra` `1` for command trees. |
| Configuration | `os.LookupEnv`, typed structs | Standard library suffices for a few values; `github.com/knadh/koanf/v2` `2` for layered sources. |
| Tests | `testing`, `net/http/httptest`, `testing/synctest` | Standard library covers unit, HTTP, concurrency, fuzzing and benchmarks. |
| Database integration tests | `github.com/testcontainers/testcontainers-go` `0.45` | Test actual database behavior. |
| Dependency security | `golang.org/x/vuln/cmd/govulncheck` `1` | Reachability-aware; complement with artifact SCA. |
| Concurrency | `context`, channels, `sync`; `golang.org/x/sync/errgroup` `0.25` | Standard library first; bounded groups when cancellation is needed. |
| Errors and IDs | `errors`, `fmt`, `uuid` | Standard library suffices for error chains and UUID v4/v7 in Go `1.27`. |

## References

| File | Covers |
| --- | --- |
| [services.md](references/services.md) | HTTP and content boundaries. |
| [data.md](references/data.md) | Codecs and persistence. |
| [messaging.md](references/messaging.md) | Durable work and broker clients. |
| [observability.md](references/observability.md) | Logs and OpenTelemetry. |
| [aws.md](references/aws.md) | Lambda and AWS service clients. |
| [ai.md](references/ai.md) | MCP and model integrations. |
| [cli.md](references/cli.md) | Commands and terminal interaction. |
| [testing.md](references/testing.md) | Behavioral and performance testing. |
| [security.md](references/security.md) | Security controls and audit tools. |
| [runtime.md](references/runtime.md) | Build and application lifecycle. |
