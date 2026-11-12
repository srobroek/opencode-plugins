---
name: lang-typescript-libraries
description: Compare TypeScript libraries before writing code for services, data, AWS, telemetry, AI, CLI, testing or security.
metadata:
  opencode/autoinvoke: false
---

# TypeScript library standards

Checked 2026-11-12.

## How to use

- Keep the project's existing choice unless the task is a migration. Prefer its code,
  the standard library, and framework features before adding a package.
- Otherwise use the default below. Use an alternative only for its listed condition.
- A departure from both needs a named gap; report the departure and why.
- Re-check fast-moving MCP, LLM SDK and OpenTelemetry releases on the registry before
  adding them. Pin the chosen version. Commit the lockfile. A package not named
  here needs approval. A registry `latest` tag can point to a prerelease.
- These defaults are engineering recommendations. Test the
  actual Node or Bun runtime, native binaries, adapters and instrumentation you ship.
- Use `toolchain-api` for API style and contract rules, `quality-code-design`'s
  `middleware.md` and `telemetry.md` for shared design rules, and `aws-guidance` for Lambda.
- Commands belong in `lang-typescript-quality` and `lang-typescript-testing`.

## Default stack

| Concern | Default | Notes |
| --- | --- | --- |
| Runtime | Node `24` LTS; Bun `1.4` for Bun projects | Check deployment support; Node `26` has native `Temporal`. |
| All new HTTP | `hono` `4` | Same app on Lambda Event/Web Functions and Node/Bun containers. |
| Existing Node HTTP | Keep the existing framework | `fastify` `5` alternative for required schema/hooks/plugin integration. |
| Middleware | Framework built-ins/hooks | Cross-cutting behavior does not belong in each endpoint. |
| Schemas | `zod` `4` | `zod/mini` for bundle pressure; validate trust boundaries. |
| OpenAPI | `@hono/zod-openapi` `1`; `@fastify/swagger` `9` | Generate from framework schemas; test the emitted contract. |
| API clients | `openapi-typescript` `7`; native `fetch` | `orval` `8` when generated query hooks are needed. |
| Typed RPC | `@orpc/server` `1` | `@trpc/server` `11` for a shared TypeScript-only stack. |
| Protobuf RPC | `@connectrpc/connect` `2` | Use a server adapter and `@bufbuild/protobuf` `2`. |
| GraphQL | `graphql-yoga` `6` | Fetch-oriented; only when GraphQL is the chosen API style. |
| Streaming | `hono` `4` SSE; `ws` `8` on Node | Native Bun server WebSockets on Bun. |
| Auth tokens | `jose` `6` | Verify issuer, audience and algorithms, not just signature. |
| HTTP clients | Native `fetch` and `AbortSignal` | Reuse SDKs/generated clients for service semantics. |
| SQL access | `drizzle-orm` `0.45` | `kysely` `0.29` when SQL-oriented query building is enough. |
| PostgreSQL | `pg` `8` | Bun built-in SQL only when portability is unnecessary. |
| Redis/Valkey | `redis` `6` | Queue/client requirements can select `ioredis` `6`. |
| Local cache | `lru-cache` `11` | Bound size and TTL; never substitute for durable state. |
| Object storage | `@aws-sdk/client-s3` `3` | Multipart: `@aws-sdk/lib-storage` `3`. |
| Jobs | `bullmq` `6` | `pg-boss` `12` if PostgreSQL is the existing durable store. |
| Workflows | `@temporalio/client` `1` | Worker/runtime compatibility must be tested separately. |
| Logging | `pino` `10` in Hono services/containers | Powertools Logger `2` on Lambda events, including Hono invocation context. |
| Telemetry | `@opentelemetry/sdk-node` `0.301`, OTLP | Stable traces/metrics; log maturity and package lines differ. |
| Lambda | Hono HTTP; Powertools `2` for event utilities | Never wrap Hono in Middy; Middy `7` optional for non-HTTP events. |
| AWS SDK | `@aws-sdk/client-*` `3` | SDK `2` support ended `2025-09-08`. |
| MCP | `@modelcontextprotocol/server` `2` | Separate client package; re-check protocol compatibility. |
| LLM abstraction | `ai` `7` | Provider SDK when its native API is needed. |
| CLI | `commander` `15`; `@clack/prompts` `1` | Bun/Node standard argument parsing for tiny CLIs. |
| Configuration | Runtime env loading plus `zod` `4` | Validate once; do not expose server secrets to clients. |
| Tests | `vitest` `5`; Bun's test runner on Bun | Match the repository runner and production runtime. |
| HTTP test doubles | `msw` `3` | Test Bun interception; real adapter tests remain necessary. |
| Properties | `fast-check` `4` | Seed failures and retain shrunk regression cases. |
| Password hashing | `@node-rs/argon2` `2` | Bun native password APIs when intentionally Bun-only. |
| Feature flags | `@openfeature/server-sdk` `1` | Inject a provider and define outage defaults. |
| Build and quality | `typescript` `7`; repository lint/build | `tsdown` `0.23` for new libraries; no bundled type-check assumption. |

## References

| File | Covers |
| --- | --- |
| [services.md](references/services.md) | HTTP frameworks and API/content integrations. |
| [data.md](references/data.md) | Schemas and storage integrations. |
| [messaging.md](references/messaging.md) | Durable jobs and broker clients. |
| [observability.md](references/observability.md) | Logging and OTel setup. |
| [aws.md](references/aws.md) | Lambda and service clients. |
| [ai.md](references/ai.md) | MCP and model integrations. |
| [cli.md](references/cli.md) | Terminal interfaces and settings. |
| [testing.md](references/testing.md) | Runtime tests and boundary verification. |
| [security.md](references/security.md) | Security controls and scanners. |
| [runtime.md](references/runtime.md) | Deployment and shared runtime helpers. |
