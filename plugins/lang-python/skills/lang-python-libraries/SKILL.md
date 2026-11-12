---
name: lang-python-libraries
description: Compare Python libraries before writing code for services, data, AWS, MCP, telemetry, CLI, testing or security.
metadata:
  opencode/autoinvoke: false
---

# Python libraries

Checked 2026-11-12.

## How to use

- Keep the project's existing choice unless the task is a migration. Prefer repository code, the standard library, framework features, then a listed library.
- Otherwise use the default below. Choose an alternative only for its listed condition.
- A departure from both needs a named gap; report the choice and reason. A dependency the request did not name needs approval, even when this guide lists it.
- Re-check fast-moving MCP, LLM SDK and OpenTelemetry rows on the package registry before adding them. Pin application additions and lock transitive dependencies; libraries declare tested ranges.
- Load the matching reference before designing or writing code for that concern. Defaults and selection conditions are recommendations, not upstream endorsements.
- Load `toolchain-api` for API style, contract standards and API test tooling. Load `quality-code-design` and its `middleware.md` and `telemetry.md` references for shared design rules.
- Keep one framework per HTTP surface: FastAPI for services that also run outside Lambda; Powertools Event Handler for Lambda-only HTTP. Never stack both on one surface.
- Load `lang-python-quality` and `lang-python-testing` for check commands; `aws-guidance` for Lambda runtime, layer and infrastructure decisions.

## Default stack

| Concern | Default | Notes |
| --- | --- | --- |
| Runtime | Python `3.14`, conventional GIL build | `3.15` is released; adopt after wheel/dependency tests |
| Packaging | `uv` `0.13` | Locked applications; workspaces for monorepos |
| API service | `fastapi` `0.162` | Keep its declared `starlette` compatibility range |
| Full-stack web | `Django` `6` | Admin, sessions, auth and ORM requirements |
| ASGI server | `uvicorn` `0.54` | One process per orchestrated container |
| Middleware | Pure ASGI; framework dependencies | Infrastructure wrappers outside route-specific authorization |
| Boundary validation | `pydantic` `2` | Internal records use `dataclasses` |
| Settings | `pydantic-settings` `2` | Validate once at startup |
| HTTP client | `httpx` `0.28` | Reuse clients; explicit timeout budget |
| OpenAPI client | `openapi-python-client` `0.30` | Model-only generation uses `datamodel-code-generator` `0.95` |
| gRPC | `grpcio` `1` | Official generated protobuf bindings |
| GraphQL | `strawberry-graphql` `0.341` | `ariadne` `1` for schema-first |
| Server push | Framework WebSockets; `sse-starlette` `3` | Test proxy timeouts and disconnect cleanup |
| Relational persistence | `SQLAlchemy` `2`, `psycopg` `3` | `Alembic` `1` migrations |
| Redis/Valkey | `redis` `8` | `valkey` `6` for a Valkey-specific stack |
| Object storage | `boto3` `1` | `fsspec`/`s3fs` `2026` for filesystem consumers |
| Data processing | `polars` `2`, `duckdb` `2` | Tabular expressions and embedded analytical SQL |
| Jobs | `dramatiq` `2` | Durable workflows use `temporalio` `1` |
| Scheduling | Platform scheduler; `APScheduler` `3` | In-process schedules are not durable queues |
| Kafka | `confluent-kafka` `2` | Do not adopt its incompatible preview line |
| Service logs | `logging` plus `structlog` `26` | Libraries only use `logging` |
| Telemetry | `opentelemetry-api`/`opentelemetry-sdk` `1` | OTLP to Collector; logs remain Development |
| AWS/Lambda | `boto3` `1`, `aws-lambda-powertools` `3` | Thin handlers, Logger/EMF Metrics, ADOT traces, no Tracer |
| MCP | `mcp` `2` | `fastmcp` `4` for richer composition/auth |
| LLM calls | `anthropic` `2` or `openai` `3` | Vendor SDK before agent framework |
| CLI | `typer` `0.29`, `rich` `15` | `argparse` for dependency-free tools |
| Tests | `pytest` `9`, `hypothesis` `6`, `coverage` `7` | Async plugin matches concurrency model |
| Auth/crypto | `PyJWT` `2`, `pwdlib` `0.3`, `cryptography` `50` | Argon2 passwords; explicit issuer/audience/algorithm |
| Quality/security | `ruff` `0.17`, `pyright` `1` or `mypy` `2` | Optional SAST, dependency audit and dead-code scans |
| Resilience | `stamina` `26` | Bounded retries only for safe operations |
| Concurrency | `asyncio` task groups; `anyio` `4` | Own tasks and propagate cancellation |
| Time/IDs | `datetime`, `zoneinfo`, `uuid` | UUIDv7 on Python `3.14` or later |
| Feature flags | `openfeature-sdk` `0.10` | Provider-independent evaluation; safe fallback |

## References

| File | Covers |
| --- | --- |
| [services.md](references/services.md) | Frameworks, middleware, protocols, auth, templates and content |
| [data.md](references/data.md) | Models, formats, databases, cache, storage, search and analytics |
| [messaging.md](references/messaging.md) | Jobs, workflows, schedules, brokers and idempotency |
| [observability.md](references/observability.md) | Logging, OpenTelemetry, metrics and telemetry tests |
| [aws.md](references/aws.md) | Lambda, Powertools, middleware, ADOT and service clients |
| [ai.md](references/ai.md) | MCP, vendor SDKs, agent frameworks and GenAI telemetry |
| [cli.md](references/cli.md) | Commands, prompts, TUI, output and configuration |
| [testing.md](references/testing.md) | Unit, property, integration, contract, load and fuzz tests |
| [security.md](references/security.md) | Crypto, sanitization, SAST, SCA, secrets, SBOM and code audits |
| [runtime.md](references/runtime.md) | Runtime, packaging, containers, lifecycle, resilience and helpers |
