# Python observability

Choose logging and OpenTelemetry packages; the shared setup checklist lives in `quality-code-design` and its `telemetry.md` reference.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Library logging | `logging` without global handler configuration | Application config supplies the destination/format | Library-owned root handlers interfere with consumers |
| Service logging | `logging` handlers plus `structlog` `26` JSON rendering | `loguru` `0.8` for standalone application convenience; existing framework logger | Competing logging stacks; assuming `contextvars` propagate across every task/thread boundary |
| Lambda logging | `aws-lambda-powertools` `3` `Logger` | Service logger for port-listening web/container reuse | Global request bindings leaking between invocations; payload logging by default |
| Trace correlation | Active OTel span fields in request-scoped logs | `opentelemetry-instrumentation-logging` `0.66b` for supported stdlib integration | Request ID or X-Ray ID is not a substitute for active `trace_id`/`span_id` |
| API/SDK | `opentelemetry-api` and `opentelemetry-sdk` `1` | Libraries depend only on API; application owns provider setup | SDK configuration in reusable libraries; SDK major does not stabilize every signal |
| OTLP export | `opentelemetry-exporter-otlp` `1`, HTTP/protobuf to Collector | gRPC for deployment/network constraints | Per-request synchronous export; implicit transport choice; duplicate SDK initialization |
| Signal maturity | SDK `1`: traces and metrics Stable, logs Development | Structured stdout plus platform collection for logs | Claiming Python logs are stable or a missing profiles status proves absence |
| Zero-code startup | `opentelemetry-distro` and `opentelemetry-instrumentation` `0.66b` | Explicit SDK setup for controlled application bootstrap | Runtime dependency mutation; mismatched SDK/instrumentation families; bootstrap has uv-specific caveats |
| HTTP instrumentation | `opentelemetry-instrumentation-fastapi`, `opentelemetry-instrumentation-django`, `opentelemetry-instrumentation-flask`, `opentelemetry-instrumentation-httpx`, `opentelemetry-instrumentation-requests` in `0.66b` | Only integrations for installed libraries; manual spans for missing boundaries | Installing all packages; duplicate server/client spans; HTTPX instrumentation does not cover MCP's `httpx2` |
| Data/AWS instrumentation | `opentelemetry-instrumentation-sqlalchemy`, `opentelemetry-instrumentation-psycopg`, `opentelemetry-instrumentation-redis`, `opentelemetry-instrumentation-botocore` in `0.66b` | Enrich existing spans; instrument missing business operations | Duplicate ORM/driver coverage without verifying nesting; database payloads/secrets in attributes |
| Metrics | `opentelemetry-sdk` `1` metrics through Collector | `prometheus-client` `0.26` for established direct scraping; Powertools EMF on Lambda | Duplicate metric systems; user/URL labels; unchecked multiprocess collection semantics |
| Optional managed backend | Keep portable OTLP | `logfire` `5` for managed Pydantic-oriented observability | Backend-specific instrumentation as the only integration path |
| Log export bridge | Structured stdout collection | SDK `LoggingHandler` in `opentelemetry-sdk` `1` for an intentional OTLP log pipeline | Double shipping through stdout and OTLP; treating Development bridge APIs as stable |
| Telemetry tests | `InMemorySpanExporter` from `opentelemetry-sdk` `1` | Signal-specific SDK readers/exporters for metric/log assertions | Random IDs/timestamps as exact expectations; unflushed asynchronous processors |

## Rules

- Configure service identity and providers at process startup, before instrumented libraries are used. Batch export and bound shutdown/flush; short-lived CLIs need explicit cleanup.
- Preserve logger APIs. Configure JSON rendering once, bind request ID separately from trace/span IDs, redact at source and clear request context after use.
- Test isolated providers with deterministic sampling. Assert parentage, span kinds/names, error status, propagation and absence of secrets.
- Keep signal maturity separate from instrumentation and semantic-convention maturity. HTTP/database spans are stable with exceptions; messaging and GenAI/MCP conventions remain Development.
- On Lambda use the Application Signals-enabled ADOT layer plus Powertools Logger/Metrics, not Powertools Tracer. See [aws.md](aws.md) for invocation lifecycle.

## Sources

- [structlog](https://www.structlog.org/), [Loguru registry](https://pypi.org/project/loguru/)
- [Python signal status](https://opentelemetry.io/docs/languages/python/), [exporters](https://opentelemetry.io/docs/languages/python/exporters/), [zero-code](https://opentelemetry.io/docs/zero-code/python/)
- [OTel logging bridge](https://opentelemetry-python.readthedocs.io/en/latest/sdk/_logs.html), [in-memory exporter](https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-sdk/src/opentelemetry/sdk/trace/export/in_memory_span_exporter.py)
- [Prometheus Python](https://prometheus.github.io/client_python/), [sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/)
- [MCP HTTP client migration](https://py.sdk.modelcontextprotocol.io/migration/), [SDK registry](https://pypi.org/project/opentelemetry-sdk/), [instrumentation registry](https://pypi.org/project/opentelemetry-instrumentation/)
