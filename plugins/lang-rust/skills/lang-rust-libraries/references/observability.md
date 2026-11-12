# Observability

Use structured Rust diagnostics with portable OpenTelemetry export and explicit provider ownership.

Checked 2026-11-12.

## Logging comparison

| Option | Fit | Selection |
| --- | --- | --- |
| `tracing` `0.1` | Scoped, async-aware spans and events | Default service facade; libraries emit without installing subscribers. |
| `log` `0.4` | Simpler log-only facade | Small synchronous libraries or existing integrations; bridge legacy events into the chosen subscriber. |
| `tracing-subscriber` `0.3` | Composable registry, JSON and `env-filter` | Binary installs one registry with per-layer filtering. |
| `tracing-opentelemetry` `0.34` | Bridge aligned to OTel `0.33` | Traces/metrics integration, not OTel log export. |

No universal logging-overhead winner was verified. Measure actual filters, formatting, span creation and export.

## Picks

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| JSON logs | `tracing` `0.1`, `tracing-subscriber` `0.3` | Existing `log` `0.4` facade through subscriber integration | Multiple global subscribers, unbounded payloads and secrets. |
| SDK/exporter | `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp` `0.33` | Direct backend OTLP for a small deployment with explicit operation plan | Incompatible SDK/bridge versions; vendor-only instrumentation. |
| Trace bridge | `tracing-opentelemetry` `0.34` | Manual SDK spans at boundaries missing tracing integration | Entered-span guards held across awaits; duplicate framework/manual spans. |
| HTTP instrumentation | `tower-http` `0.7` plus bridge/context propagation | `axum-tracing-opentelemetry` `0.42`, `init-tracing-opentelemetry` `0.44` when compatible | Assuming request logs automatically extract/inject distributed context. |
| Log export/correlation | `opentelemetry-appender-tracing` `0.33` when OTLP logs are needed | JSON stdout collected by the platform; add active `trace_id`/`span_id` explicitly | Assuming plain JSON formatter inserts OTel IDs; double-shipping stdout and OTLP logs. |
| Metrics | `opentelemetry_sdk` `0.33` metrics over OTLP | `metrics` `0.24`, `metrics-exporter-prometheus` `0.18` for existing scrape-only platforms | Duplicate instruments/pipelines, raw URLs or user/request IDs as labels. |
| Telemetry tests | `opentelemetry_sdk` `0.33` in-memory exporters/readers | Collector integration test for OTLP transport behavior | Global test provider races; assertions on random IDs or exact timing. |

## Signal readiness

| Signal/component | Observed status | Consequence |
| --- | --- | --- |
| Traces API/SDK/OTLP | Beta | Pin compatible versions and test upgrades; do not call all Rust OTel stable. |
| Metrics API/SDK/OTLP | Stable | Default portable metrics path. |
| Logs/bridge | Stable | Stable signal does not stabilize every instrumentation package. |
| OTel Prometheus exporter | Beta | Existing scrape platform can use the metrics ecosystem instead. |
| Profiles | No Rust SDK status listed; cross-language spec alpha | No standard Rust profiles SDK recommendation established. |

## Rules

- Initialize providers at the binary boundary; configure `service.name`, `service.version`, `deployment.environment.name`, sampling and explicit OTLP transport. Default path is SDK to Collector to backend.
- Extract/inject W3C trace context and allowlisted baggage at HTTP/RPC/message boundaries. Request IDs are not distributed trace IDs.
- Name route/operation spans, not individual requests. Record relevant failures once; apply protocol-specific status semantics. Exclude tokens, payload contents and personal data.
- End spans and use bounded flush/shutdown on process exit. Lambda needs invocation-end flushing without shutting down reusable providers each time.
- Isolate test providers; enable SDK `testing` features as needed. Assert parentage, operation, attributes, errors, propagation and redaction.
- Use `quality-code-design`'s `telemetry.md` for shared setup rules and `middleware.md` for boundary composition. HTTP/database span conventions are stable with exceptions. Messaging and GenAI/MCP conventions remain development.

## Sources

- [Rust OTel status](https://github.com/open-telemetry/opentelemetry-rust#project-status), [language status](https://opentelemetry.io/docs/languages/).
- [Tracing subscriber](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/), [trace bridge](https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/), [log bridge](https://docs.rs/opentelemetry-appender-tracing/latest/opentelemetry_appender_tracing/).
- [SDK test exports](https://docs.rs/opentelemetry_sdk/latest/opentelemetry_sdk/trace/), [OTLP exporter](https://opentelemetry.io/docs/specs/otel/protocol/exporter/), [Collector](https://opentelemetry.io/docs/collector/).
