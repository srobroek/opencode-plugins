# Logging, metrics and tracing

Use structured logs and OpenTelemetry over OTLP, with runtime-specific instrumentation tests.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Service logging | `pino` `10`: JSON, child loggers, redaction, transports | `winston` `3` for existing transport investment; `consola` `3` for CLI output; `@logtape/logtape` `2` for cross-runtime logging. | Serializing JSON by hand; pretty logs in production; secrets or unrestricted request bodies. |
| Request logs | Small Hono middleware over `pino` `10` for services/containers | Fastify native Pino integration or `pino-http` `11` in existing Node HTTP/Express apps. | New `hono-pino` adoption: security-only maintenance; assuming Node HTTP middleware fits Fetch handlers. |
| Local pretty output | `pino-pretty` `13` development transport | Existing console renderer for CLIs. | Worker transports on Lambda without proving flush/completion; synchronous network logging per request. |
| Lambda event logs | `@aws-lambda-powertools/logger` `2`; small Hono middleware reads adapter event/context bindings for HTTP | Pino for native Hono Web Functions/server requests without the traditional invocation contract. | Middy around Hono; carrying stale invocation fields between warm calls. |
| OTel API and bootstrap | `@opentelemetry/api` `1`; `@opentelemetry/sdk-node` `0.301` | Direct signal SDK setup when the deployment needs it. | Labeling all OTel JS packages `2` or `3`; installing mismatched peer/dependency lines. |
| Node instrumentation | `@opentelemetry/auto-instrumentations-node` `0.83`, narrowed to required integrations | Explicit HTTP, Undici, PostgreSQL, Redis and AWS SDK instrumentation from compatible releases. | SDK initialization after instrumented imports; assuming ESM loader interception without testing. |
| Bun instrumentation | Bun `1.4` plus early NodeSDK bootstrap and explicitly tested instrumentations | Manual spans for native Bun HTTP/fetch and uncovered paths. | Claiming every Node auto-instrumentation works: Bun documents HTTP/fs compatibility, not blanket native API coverage. |
| OTLP | `@opentelemetry/exporter-trace-otlp-proto` and `@opentelemetry/exporter-metrics-otlp-proto` from the same release line as `sdk-node`, or NodeSDK exporters selected by `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`; export to a collector | OTLP/gRPC when infrastructure requires it. The `-otlp-http` exporters send JSON, not the shared `http/protobuf` default. | Backend-specific business instrumentation or mixing duplicate exporters/providers. |
| Metrics | `@opentelemetry/sdk-metrics` `3` plus OTLP exporter | Powertools Metrics `2` EMF on Lambda; existing Prometheus endpoint when its scrape model is required. | Request IDs/users as metric labels; custom metrics JSON or synchronous per-event publishing. |
| Prometheus scraping | `@prometheus-io/client` `0.16` when direct scraping is required | OTel metrics/collector for the shared telemetry pipeline. | New `prom-client` `15` adoption: npm-deprecated in favor of this replacement. |
| Signal maturity | Stable JS traces and metrics; logs still development in the published language status table | `@opentelemetry/sdk-logs` `3` only after verifying API/SDK stability for the pinned release. | Inferring stability from the package's major number or auto-instrumentation availability. |
| Trace/log correlation | `@opentelemetry/instrumentation-pino` `0.71` or explicit active-context fields | Add trace/span IDs to Powertools log context when using ADOT. | Treating the AWS request ID or X-Ray header as an OTel trace/span pair; duplicate log export. |
| Sentry integration | `@sentry/node` `11` with one chosen tracing owner | Existing OTel: initialize your provider first; set `enableOpenTelemetrySetup: false`, leave Sentry tracing samplers unset, add `openTelemetryIntegration()`. | Assuming older Sentry provider behavior: default Sentry `11` spans operate without an OTel pipeline; two competing providers. |
| Telemetry tests | Compatible SDK in-memory exporters/readers; actual runtime integration tests | Collector-backed smoke tests for export and propagation. | Tests that assert only log text while spans lose parent context or shutdown drops buffers. |

## Rules

- Initialize before application imports. Node ESM instrumentation may require a loader
  as well as early initialization through `--import`; Bun uses `--preload`.
  Test the pinned setup and instrumentation loader requirements.
- Flush Powertools Metrics per Hono Lambda request, including failure paths, and clear
  invocation-owned fields. Pino children are request-local on concurrent HTTP servers.
- Set `service.name`, `service.version`, and `deployment.environment.name`. Explicitly
  choose OTLP transport, sampling and resource detection; allowlist propagated baggage.
- Use JSON stdout logs, bounded attributes and redaction. Configure Pino child loggers
  with validated request identity; ensure failures also get latency/status logs.
- Pino instrumentation supports Pino `>=5.14 <11`; it injects `trace_id`, `span_id`
  and `trace_flags` and can send logs to OTel. Avoid exporting the same logs twice.
  Keep the existing provider, context manager, propagators and instrumentations when
  adding Sentry's OTel integration; its OTLP endpoint is an optional export destination.
- Verify HTTP, database and queue propagation on Node and Bun, and flush SDK/transports
  during graceful shutdown. Instrument business operations, not only framework internals.
- Follow `quality-code-design`'s `telemetry.md`; shared middleware rules are in its
  `middleware.md`. Lambda-specific setup is in [aws.md](aws.md).

## Sources

- [Pino transports](https://github.com/pinojs/pino/blob/main/docs/transports.md), [Pino OTel instrumentation](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-pino).
- [Hono Pino maintenance notice](https://github.com/maou-shonen/hono-pino), [Powertools Logger](https://docs.aws.amazon.com/powertools/typescript/latest/features/logger/).
- [OTel JS](https://opentelemetry.io/docs/languages/js/), [SDK status](https://opentelemetry.io/docs/languages/), [ESM support](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md).
- [Bun `1.4`](https://bun.com/blog/bun-v1.4), [Sentry custom pipeline](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/custom-setup/).
- [Registry metadata](https://registry.npmjs.org/).
