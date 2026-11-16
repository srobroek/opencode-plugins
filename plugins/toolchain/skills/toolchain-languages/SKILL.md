---
name: toolchain-languages
description: Use when choosing a language, picking a library or tool, or before writing your own code for a common concern.
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
| Every language's testing and quality concerns (test runner, fuzzing, mutation, contracts, SAST, dependency audit and more); read before you choose or report a check | [references/concerns.md](references/concerns.md) |
| Checks that depend on the product surface (web, mobile, desktop, HTTP API, CLI), not the language: end-to-end, visual, accessibility, journeys | [references/surfaces.md](references/surfaces.md) |
| Tools shared by every language: Testcontainers, Pact, Schemathesis, Hurl, oasdiff, k6, OSV-Scanner, fuzzing services, Semgrep, Opengrep, CodeQL, Lizard, jscpd, Gitleaks; versions, install, tradeoffs | [references/shared-tools.md](references/shared-tools.md) |
| Java, Kotlin, .NET, Ruby, PHP, Swift, C and C++ (documented choices, no language plugin) | [java](references/java.md), [kotlin](references/kotlin.md), [dotnet](references/dotnet.md), [ruby](references/ruby.md), [php](references/php.md), [swift](references/swift.md), [cpp](references/cpp.md) |
| Shell, Terraform/OpenTofu and AWS CDK concerns | `shell-language`, `terraform-language`, `aws-guidance` (its `references/cdk.md`) |
| A language without a `lang-<language>-libraries` skill | The rules below, then research as in step 2 |

## Choosing a language

For a new project or component. An existing codebase's language wins for code that lives inside it. Record the choice and its reasons in a decision record (`quality-code-design`'s `lifecycle.md`).

| Factor | What to check |
| --- | --- |
| Where it runs | Browser or shared client/server types: TypeScript. Desktop: Tauri (Rust core, TypeScript UI). A CLI shipped as one static binary: Go or Rust. AWS Lambda runs all four. Powertools exists for Python, TypeScript, Java and .NET only. Lambda Web Functions are Node-only. SnapStart covers Java, Python and .NET. Go and Rust use the OS-only runtime, with small cold starts |
| Ecosystem fit | Does the `lang-<language>-libraries` standard have a maintained default for every concern the project needs (SDKs, MCP, data, messaging)? Data science, ML and notebooks: Python |
| Performance and resources | Only a measured or clearly stated need (CPU-bound work, memory ceilings, tail latency, binary size) justifies Go or Rust over the team's usual language |
| Correctness and safety | Rust for memory-safety-critical or concurrency-heavy systems code; strict TypeScript, Python with a type checker, or Go otherwise |
| Telemetry maturity | OpenTelemetry signal status differs: Go has all three signals stable; Python and JavaScript logs are in development; Rust traces are beta |
| Team and lifetime | Who maintains it, how they hire, and the supported-version cycle (Node LTS, Python releases with five-year support, Go's two supported releases, Rust stable every six weeks) |
| Build and feedback loop | Rust compile times and Python or TypeScript start-up and packaging against the iteration speed the project needs |
| Integration surface | One language per deployable unit; across units, agree on the wire contract (`toolchain-api`) instead of sharing code |

Starting points, not rules:

- TypeScript: web backends, full-stack apps, AWS-heavy Lambda APIs (Hono with Powertools).
- Python: data, ML, scripting, Lambda glue (Powertools).
- Go: network services, infrastructure tooling, static-binary CLIs.
- Rust: performance- or safety-critical components, WASM, Tauri apps.

## How to choose a library

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
| Cross-cutting concerns | The framework's middleware, interceptors, layers or decorators; one middleware model per surface (an HTTP API, an RPC API) |
| Telemetry | OpenTelemetry SDK, OTLP over `http/protobuf` to a Collector; structured JSON logs carrying `trace_id` and `span_id` |
| AWS Lambda (Python, TypeScript, Java, .NET) | Powertools for AWS Lambda utilities over hand-rolled code; ADOT/Application Signals layer for traces; Powertools Logger and Metrics without its X-Ray Tracer |
| AWS Lambda (Go, Rust) | No Powertools: the official runtime crate or module, the language's structured logger, the OTel SDK with the Collector extension |
| Configuration | Typed settings parsed and validated once at startup; secrets from a secret store, never committed |
| Validation | Schema validation at every trust boundary (request, message, file, environment) |
| Outbound HTTP | A reused client with explicit timeouts and cancellation; retries bounded, with jitter, only for idempotent operations |
| Errors | Typed domain errors inside; one mapping at the boundary (RFC 9457 problem details for HTTP) |
| Persistence | SQL-first access with reviewed, committed migrations; a pool per process; real-database integration tests |
| Background work | A durable queue or workflow engine with idempotent handlers, never in-process fire-and-forget for work that must survive |
| Service clients | The SDK for control-plane calls and simple exact requests; a maintained higher-level library when it removes a concrete burden (mapping, pagination, multipart, leasing, caching, replay) or is markedly simpler, even when an official helper exists |
| IDs and time | UUIDv7 for sortable ids (UUIDv4 when creation time must stay private); timezone-aware UTC instants |
| Feature flags | Applications/services/CLIs: OpenFeature with one provider over flags.yaml, SSM or AppConfig, chosen by need; ask before writing a missing provider. Libraries take caller decisions; OpenCode plugins keep options. See `quality-code-design`'s `feature-flags.md` |
| MCP | The official SDK for the language, at least its current release; stdio locally, Streamable HTTP remotely |
| Tests and quality checks | Every language fills the concerns in [references/concerns.md](references/concerns.md) in its own table; report a concern you could not run as not run |

## Java and .NET

There are no language plugins for these. Read [references/java.md](references/java.md), [kotlin.md](references/kotlin.md) or [dotnet.md](references/dotnet.md) for the testing and quality tools, and [references/shared-tools.md](references/shared-tools.md) for the shared ones. On Lambda, use Powertools for AWS Lambda (Java 2, .NET 3) and the AWS SDK; SnapStart for latency-sensitive Java functions after restore testing. Research other picks with the steps above.
