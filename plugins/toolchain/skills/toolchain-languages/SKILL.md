---
name: toolchain-languages
description: Use when picking a library or tool for any language, or before writing your own code for a common concern.
metadata:
  opencode/autoinvoke: false
---

# Library and tool standards

Checked 2026-11-12. This skill holds the cross-language rules and routes to the per-language standards. Before you design or write code for a concern (an HTTP service, middleware, validation, persistence, a cache, a queue consumer, telemetry, a CLI, an API client, an AWS integration), compare the plan with the standards below and report each departure.

## Where the standards live

| Need | Load |
| --- | --- |
| Library, framework and tool defaults for one language | `lang-python-libraries`, `lang-typescript-libraries`, `lang-go-libraries`, `lang-rust-libraries` (each: a default stack in `SKILL.md`, details per area in `references/`) |
| API style (REST/OpenAPI, gRPC, Connect, GraphQL, events, webhooks, MCP), spec versions, design rules, API test tools | `toolchain-api` |
| AWS Lambda structure, Powertools, Lambda telemetry, AWS service clients versus the raw SDK | `aws-guidance` |
| Middleware and telemetry rules that hold in every language | `quality-code-design`: `middleware.md`, `telemetry.md` |
| Quality and security scanners, dead-code tools, CI gates | `lang-<language>-quality`, `toolchain-quality-observability`, `ci-github-actions` |
| A language without a `lang-<language>-libraries` skill | The rules below, then research as in step 2 |

## How to choose

1. **Keep the project's choice.** An existing library for the concern wins unless the task is a migration.
2. **Research before you build.** Read current official documentation (context7, the project site, the registry) for the concern and the candidates; note the version and date you checked. Check the standard library and the framework's own features first: built-in middleware, validation, the platform's SDK helpers, Powertools on Lambda, OpenTelemetry instrumentation packages.
3. **Use the listed default**, or a listed alternative whose condition holds.
4. **Write your own only for a named gap**: a required contract, deployment or licence constraint, measured performance need, or a simpler complete solution. Keep the custom scope small and report the gap.
5. **Check health before you add a dependency:** latest release and date, maintenance notices, archived status, RustSec/GHSA/OSV advisories, licence, runtime compatibility (Bun versus Node, CGO, musl, Lambda architecture). Release age alone does not prove abandonment; an explicit maintenance notice or archive does.
6. **Pin what you add**, and never take a registry `latest` tag that points to a prerelease.
7. **Ask first:** a dependency the request did not name needs approval.

## Defaults that hold in every language

| Concern | Default |
| --- | --- |
| Cross-cutting concerns | The framework's middleware, interceptors, layers or decorators; one middleware model per HTTP surface |
| Telemetry | OpenTelemetry SDK, OTLP over `http/protobuf` to a Collector; structured JSON logs carrying `trace_id` and `span_id` |
| AWS Lambda (Python, TypeScript, Java, .NET) | Powertools for AWS Lambda utilities over hand-rolled code; ADOT/Application Signals layer for traces; Powertools Logger and Metrics without its X-Ray Tracer |
| AWS Lambda (Go, Rust) | No Powertools: the official runtime crate or module, the language's structured logger, the OTel SDK with the Collector extension |
| Configuration | Typed settings parsed and validated once at startup; secrets from a secret store, never committed |
| Validation | Schema validation at every trust boundary (request, message, file, environment) |
| Outbound HTTP | A reused client with explicit timeouts and cancellation; retries bounded, with jitter, only for idempotent operations |
| Errors | Typed domain errors inside; one mapping at the boundary (RFC 9457 problem details for HTTP) |
| Persistence | SQL-first access with reviewed, committed migrations; a pool per process; real-database integration tests |
| Background work | A durable queue or workflow engine with idempotent handlers, never in-process fire-and-forget for work that must survive |
| Service clients | The SDK for control-plane calls; a higher-level library when it removes a concrete burden (mapping, pagination, multipart, leasing, caching, replay) |
| IDs and time | UUIDv7 for sortable ids (UUIDv4 when creation time must stay private); timezone-aware UTC instants |
| Feature flags | OpenFeature SDK with the provider you use |
| MCP | The official SDK for the language, pinned; stdio locally, Streamable HTTP remotely |
| Tests | The language's standard runner, property tests for invariants, real dependencies in containers for integration tests |

## Java and .NET

There are no language plugins for these. On Lambda, use Powertools for AWS Lambda (Java 2, .NET 3) and the AWS SDK; SnapStart for latency-sensitive Java functions after restore testing. Research other picks with the steps above.
