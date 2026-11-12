---
name: lang-rust-libraries
description: Compare Rust libraries before writing code for web, data, messaging, AWS, MCP, telemetry, CLI, testing or security.
metadata:
  opencode/autoinvoke: false
---

# Rust libraries

Checked 2026-11-12.

## How to use

- The project's existing choice wins unless the task is a migration. Prefer repository code, the standard library, framework features, then a listed crate.
- Otherwise use the default. An alternative needs its listed condition. A departure from both needs a named gap; report the departure and reason.
- Re-check fast-moving MCP, LLM and OTel rows on the registry before adding them. Pin additions; check features, target support, MSRV and the resolved dependency graph.
- A dependency the request did not name needs approval, even when this guide lists it. Add only what the concern needs, not the whole stack.
- Versions are observed major/minor lines, not upgrade instructions or compatibility guarantees. Defaults and selection rules are recommendations, not measured performance rankings.
- Load `toolchain-api` for API style, standards and contract tooling. Load `quality-code-design`'s `middleware.md` and `telemetry.md` for shared design rules. Use `aws-guidance` for Lambda architecture.
- Commands belong in `lang-rust-quality` and `lang-rust-testing`. Desktop/Tauri details belong in `lang-rust-tauri`.

## Default stack

| Concern | Default | Notes |
| --- | --- | --- |
| Toolchain | Rust `1.100`, edition `2024` | Declare library MSRV independently. |
| Async I/O | `tokio` `1.54` | LTS is a separate choice; sync for sequential tools. |
| CPU work | `rayon` `1.12` | Bound work submitted from async handlers. |
| HTTP service | `axum` `0.8` | Native Tower composition. |
| Middleware | `tower` `0.5`, `tower-http` `0.7` | Prefer readable `ServiceBuilder` ordering. |
| HTTP quotas | `tower_governor` `0.8` | Process-local, not a distributed quota. |
| HTTP client | `reqwest` `0.13` | `ureq` `3.5` for blocking CLIs. |
| gRPC/protobuf | `tonic` `0.14`, `prost` `0.14` | Check current generation integration. |
| OpenAPI | `utoipa` `6`, `progenitor` `0.16` | Client generator documents OpenAPI `3.0.x`. |
| GraphQL | `async-graphql` `7.2` | Only when graph-shaped queries justify it. |
| JSON | `serde` `1`, `serde_json` `1` | Profile before a SIMD substitution. |
| Validation/schema | `validator` `0.21`, `schemars` `1.2` | Schema generation is not domain validation. |
| SQL | `sqlx` `0.9` | SQL-first, built-in pools and migrations. |
| Shared/local cache | `redis` `1.8`, `moka` `0.12` | Bound TTL and capacity. |
| Object storage | `object_store` `0.14` | AWS-specific operations: `aws-sdk-s3` `1`. |
| Background jobs | `apalis` `1.1` | Durable workflows: `temporalio-sdk` `1.2`. |
| Kafka/AMQP/NATS | `rdkafka` `0.39`, `lapin` `4.12`, `async-nats` `0.52` | Match the existing broker. |
| Logging | `tracing` `0.1`, `tracing-subscriber` `0.3` | One binary-owned JSON subscriber. |
| Telemetry | `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp` `0.33` | OTLP to Collector; traces beta, logs/metrics stable. |
| Trace bridge | `tracing-opentelemetry` `0.34` | Separate OTel log bridge when needed. |
| AWS SDK | `aws-config` `1`, service-specific `aws-sdk-*` `1` | Service crates version independently. |
| Lambda | `lambda_runtime` `1.5`, `lambda_http` `1.3` | No official Rust Powertools. |
| MCP | `rmcp` `3.9` | Official SDK; re-check spec and transports. |
| OpenAI/provider abstraction | `async-openai` `0.43`, `rig-core` `0.46` | Community SDKs; check MSRV and API coverage. |
| CLI/TUI | `clap` `4.6`, `ratatui` `0.30` | Do not prompt in automation. |
| Configuration | `config` `0.15` | Explicit precedence; secrets stay redacted. |
| Errors | `thiserror` `2`, `anyhow` `1` | Typed library/domain errors; reports in binaries. |
| TLS/passwords/JWT | `rustls` `0.23`, `argon2` `0.6`, `jsonwebtoken` `11` | Validate algorithms, issuer and audience. |
| IDs/time | `uuid` `1`, `jiff` `0.2` | UUID `v7` discloses time; `v4` avoids that. |
| Tests | `cargo-nextest` `0.9`, `proptest` `1`, `insta` `1` | Keep standard doctests. |
| Integration tests | `wiremock` `0.6`, `testcontainers` `0.28` | Real persistence semantics, owned-boundary doubles. |
| Security/dependencies | `cargo-deny` `0.20`, `cargo-machete` `0.9` | Feature/target-aware review, not a safety certificate. |

## References

| File | Covers |
| --- | --- |
| [services.md](references/services.md) | Framework/client comparisons, middleware, contracts, auth and content |
| [data.md](references/data.md) | Serialization comparisons, formats, SQL comparisons, cache, storage and analytics |
| [messaging.md](references/messaging.md) | Jobs, workflows, schedules, brokers and idempotency |
| [observability.md](references/observability.md) | Logging comparison, OTel signals, correlation and telemetry tests |
| [aws.md](references/aws.md) | SDK, Lambda adapters, Powertools substitutes and service clients |
| [ai.md](references/ai.md) | MCP, LLM SDKs, provider abstraction and GenAI telemetry |
| [cli.md](references/cli.md) | CLI, prompts, terminal output and settings |
| [testing.md](references/testing.md) | Unit, async, property, integration, fuzz, load and benchmark tools |
| [security.md](references/security.md) | Crypto, secrets, input controls and quality/security scanners |
| [runtime.md](references/runtime.md) | Runtime/error comparisons, builds, resilience, concurrency and utilities |
