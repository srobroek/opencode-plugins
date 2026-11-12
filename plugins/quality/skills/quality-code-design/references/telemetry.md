# Telemetry: OpenTelemetry by default

Read when a change adds or touches a service, worker, consumer, CLI that calls the network, or Lambda function, or adds logs, traces or metrics. Checked 2026-11-12. These rules are language-neutral: SDK packages, bootstrap commands and signal stability for each language are in the `lang-<language>-libraries` skill's `observability.md`; Lambda specifics are in the `aws-guidance` skill.

New code emits OpenTelemetry. An existing project keeps its telemetry stack unless the task is a migration.

## Setup

- **Bootstrap at the entry point**, before instrumented libraries load. Libraries depend on the OTel API only and never configure an SDK.
- **Identify the service:** set `service.name`, `service.version` and `deployment.environment.name`. `OTEL_SERVICE_NAME` overrides `service.name`. Review what resource detectors collect.
- **Configure through `OTEL_*` variables** where the SDK supports them. Declarative file configuration (`OTEL_CONFIG_FILE`) is experimental outside Java; do not require it.
- **Export OTLP** with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (port 4318) unless the deployment favours gRPC (4317), to an OpenTelemetry Collector. The Collector owns retries, filtering, redaction, tail sampling and backend routing. Export straight to a vendor only in development or in a deployment with one service and one backend.
- **Propagate** W3C `tracecontext` and `baggage` (the default `OTEL_PROPAGATORS`) at every HTTP, RPC and messaging boundary. Allowlist baggage keys.
- **Sample deliberately.** The default sampler is `parentbased_always_on`. Set `parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG` when volume needs it; make error- or latency-based decisions with Collector tail sampling.
- **Batch and flush.** Use batch processors in production and end every span. On exit, call a bounded flush and shutdown: CLIs and short jobs lose telemetry without it. On Lambda, flush at the end of each invocation through the Lambda-aware layer and do not shut providers down per invocation.
- **Auto-instrument boundaries, hand-instrument meaning.** Use zero-code or library instrumentation for frameworks and clients, and manual spans for business operations. Enrich an existing span before you add a duplicate.
- **Pin semantic conventions.** HTTP and database client spans are stable; messaging and GenAI conventions are in development (semantic conventions 1.45.0). Use `OTEL_SEMCONV_STABILITY_OPT_IN` values only as the installed instrumentation documents them.
- **One tracing owner.** Do not run a second tracing SDK over the same clients (for example the X-Ray SDK next to OTel, or a vendor agent that installs its own provider).

## Spans, metrics and logs

- Name spans for the operation or route template (`GET /orders/{id}`), never with ids or user data.
- Keep metric attributes bounded: no user ids, raw URLs, request ids or free text. A span attribute may carry an id when it has diagnostic value and no privacy cost.
- When an operation fails, record the exception once, at the boundary that decides the outcome, and set the span status to error.
- Use counters for accumulated events, histograms for durations and sizes, and up-down counters for quantities that rise and fall. Keep exemplars (`OTEL_METRICS_EXEMPLAR_FILTER=trace_based`) so metric outliers link to traces.
- Logs are structured JSON with `trace_id` and `span_id` while a span is active. Bridge the existing logger into OTel instead of changing logging APIs. Ship logs one way: OTLP when there is a deliberate OTel log pipeline, otherwise stdout to the platform's collector, never both.
- Keep credentials and personal data out of attributes, events, logs and baggage. Hashing a predictable identifier does not anonymize it.
- For LLM and MCP calls, record the model, duration, token usage and failures. Keep prompts and completions out unless the user approved capturing them; several instrumentations capture content by default.

## Test telemetry

**Do:** use the SDK's in-memory exporter with an isolated provider, a simple processor and always-on sampling. Assert span names, kinds, parentage, attributes, status, propagation and the absence of secrets.
**Do not:** assert timestamps or random ids, or share a global provider between tests.

## Anti-patterns

- A span per loop iteration without diagnostic value.
- Unbounded metric attributes or dynamic span names.
- Vendor-specific instrumentation as the only integration path instead of OTLP.
- Exiting without a flush.

## Sources

- SDK status per language: https://opentelemetry.io/docs/languages/
- SDK environment variables: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
- OTLP exporter configuration: https://opentelemetry.io/docs/specs/otel/protocol/exporter/
- Collector: https://opentelemetry.io/docs/collector/
- Sampling: https://opentelemetry.io/docs/concepts/sampling/
- Trace API naming rules: https://opentelemetry.io/docs/specs/otel/trace/api/
- Exceptions: https://opentelemetry.io/docs/specs/otel/trace/exceptions/
- Metrics API: https://opentelemetry.io/docs/specs/otel/metrics/api/
- Semantic conventions 1.45.0: https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.45.0
- Sensitive data: https://opentelemetry.io/docs/security/handling-sensitive-data/
- GenAI conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
