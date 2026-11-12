---
name: toolchain-api
description: Use when choosing or designing an API (REST/OpenAPI, gRPC, Connect, GraphQL, events, webhooks, MCP) or its tests.
metadata:
  opencode/autoinvoke: false
---

# API standards

Checked 2026-11-12. Per-language frameworks and generators are in the `lang-<language>-libraries` skills (`services.md`); wire-contract hygiene (committed codegen, one casing, conformance tests) is in `quality-code-design`'s `contracts.md`.

## Pick the style

| Situation | Default | Choose instead when | Costs to plan for |
| --- | --- | --- | --- |
| Public or partner API | HTTP+JSON, resource-oriented, described with OpenAPI | - | SDK generation, consistent pagination and errors, long migration windows for breaking versions |
| Browser or mobile client of your own backend | HTTP+JSON with OpenAPI | Connect for typed RPC with generated clients; GraphQL when clients need materially different graph-shaped reads | GraphQL adds resolver authorization, query-cost limits, N+1 control and special caching |
| Internal service to service | HTTP+JSON, or gRPC/Connect when generated contracts across teams or languages pay off | - | Protobuf toolchain and plugin pinning; native gRPC needs HTTP/2-aware proxies and trailers; binary payloads are harder to inspect |
| High-throughput, low-latency internal path | Benchmark gRPC with protobuf first | Keep HTTP+JSON when the benchmark shows no material gain | Binary encoding alone does not prove lower end-to-end latency |
| Server push to browsers | Server-sent events | gRPC/Connect server streaming for typed internal streams | Test proxy buffering and idle timeouts; streams are not cacheable |
| Bidirectional streaming | gRPC internally; WebSockets for browsers | Connect where HTTP/2 is guaranteed end to end | Backpressure, reconnect and resume, message contracts; Connect bidi needs HTTP/2 |
| Asynchronous events between services | A broker, described with AsyncAPI 3, with a CloudEvents envelope | - | Delivery semantics, ordering, replay, deduplication and schema evolution; no spec gives exactly-once |
| Callbacks to partners | HTTP POST following Standard Webhooks 1.0 | - | Signing and key rotation, retry queue, replay protection, receiver deduplication, SSRF defenses on your sender |
| Tools for AI agents | MCP (spec 2026-07-28) over stdio locally or Streamable HTTP remotely | - | Protocol version negotiation, tool schemas, authorization, host permissions; JSON-RPC alone is not MCP |
| Command-style RPC an ecosystem requires | JSON-RPC 2.0 | - | Discovery, auth, schemas and versioning are separate work; HTTP caching and status codes fit poorly |

Decision order:

1. Tools for AI agents: MCP.
2. Durable asynchronous notifications: AsyncAPI with CloudEvents; Standard Webhooks for partners.
3. Server push to browsers: SSE. Bidirectional browser traffic: WebSockets.
4. Typed internal RPC or bidirectional streams: gRPC. Typed RPC from browsers: Connect.
5. Graph-shaped client queries: GraphQL.
6. Everything else: HTTP+JSON with OpenAPI.

## What ConnectRPC is

Connect is an RPC protocol and a family of libraries. ConnectRPC is a CNCF sandbox project, originally created by Buf. You define services in protobuf, as for gRPC, and generate clients and servers.

- **On the wire:** a unary call is an HTTP `POST` to `/<package>.<Service>/<Method>` with an unframed body: protobuf JSON (`application/json`) or binary protobuf (`application/proto`). Side-effect-free methods can use `GET`. Headers carry `Connect-Protocol-Version: 1` and `Connect-Timeout-Ms`. Unary errors are a non-200 status with a JSON body `{code, message, details}`. Streams use `application/connect+json` or `application/connect+proto` with length-prefixed envelopes; the final envelope carries the error and trailing metadata.
- **No HTTP trailers:** unary trailing metadata travels as `Trailer-*` headers and streaming trailers in the body, so ordinary proxies, load balancers, `curl` and browsers work.
- **HTTP versions:** unary, server streaming and client streaming work over HTTP/1.1 and HTTP/2; bidirectional streaming needs HTTP/2.
- **Three protocols per server:** a Connect server also accepts gRPC and gRPC-Web on the same port, chosen per request by `Content-Type`. Clients pick a transport; nothing falls back automatically. Browsers call a Connect or gRPC-Web endpoint directly with no translating proxy, for unary and server streaming. An existing gRPC-only server needs a gRPC transport on the client.
- **Implementations:** Go `connect-go` 2 (module `connectrpc.com/connect/v2`) and TypeScript `connect-es` 2 (browser, Node; Bun needs its own adapter) are established; Swift 1 and Dart 2 clients; Python `connect-python` 0.13, Kotlin 0.10 and Rust `connectrpc` 0.9 are pre-1.0 and need integration tests.
- **Tooling:** `buf curl` calls any method; Protovalidate adds CEL validation rules (choosing Connect does not validate anything by itself).

Choose Connect for protobuf-first APIs used from browsers, mobile apps and backends that also want gRPC interoperability and plain-HTTP debugging. Choose gRPC for existing gRPC infrastructure or a language Connect does not cover well, and REST with OpenAPI for resource semantics, the broadest public ecosystem and HTTP caching.

## Specification versions

| Spec | Status | Use |
| --- | --- | --- |
| OpenAPI | 3.2.1 (2026-09-10) and 3.1.2 published; both use JSON Schema 2020-12 with OAS extensions | 3.1.2 for an existing pipeline; 3.2 once every generator, linter and docs tool in the chain passes fixtures |
| Arazzo, Overlay | Arazzo 1.1.0 (workflows), Overlay 1.2.0 (declarative edits) | Optional companions to the base document, never replacements |
| AsyncAPI | 3.1.0 | Use 3.x-aware tooling; 2.x tools do not carry over |
| Protobuf | Editions 2023 and 2024 released; wire format unchanged | The newest edition every plugin and runtime in the chain supports; proto3 stays a valid compatibility choice |
| GraphQL | September 2025 edition; GraphQL-over-HTTP is a working draft without subscriptions | Pin the released edition and a tested HTTP profile; choose the subscription transport separately |
| CloudEvents | 1.0 (main branch is 1.0.3-wip) | Pin a released tag; the envelope version is not the payload schema version |
| Standard Webhooks | 1.0.0 | Signature headers, timestamps and retries as the spec defines |
| MCP | 2026-07-28 | Pin the SDK and protocol version; older handshake and session assumptions do not carry over |

## Own the contract

- Keep one authoritative contract per API. Schema-first fits public and partner APIs, several teams and several languages. Code-first fits one owning team that validates close to the handlers (FastAPI, Hono `@hono/zod-openapi`, Huma, utoipa or aide).
- Either way, export a deterministic contract file, commit it, review its diff, generate clients from it and test the wire behavior against the real server.
- Protobuf: use the Buf CLI with v2 configuration (`buf.yaml`, `buf.gen.yaml`) for `buf generate`, `buf lint`, `buf format` and `buf breaking`; pin the CLI and plugins and lock dependencies. Version packages (`orders.v1`), reserve deleted field numbers and names.

## Design rules

| Area | Rule | Source |
| --- | --- | --- |
| Resources and methods | Plural nouns for collections; `GET`/`HEAD` safe, `PUT`/`DELETE` idempotent, `POST` for create and actions; document `PATCH` semantics, never assume it is idempotent | RFC 9110 |
| Errors | `application/problem+json` (RFC 9457) with a stable `type`, the correct status and validation details; no stack traces or secrets | RFC 9457 |
| Pagination | Opaque cursor tokens with a deterministic order and a unique tie-breaker; bounded page size; offset only for small, stable collections that need random access | Google AIP-158 |
| Filtering, sorting, fields | Allowlisted fields and operators, bounded complexity, explicit field masks; never pass raw SQL or skip field-level authorization | AIP-160, AIP-161 |
| Idempotency | `Idempotency-Key` on unsafe retried requests: document scope and expiry, reject a reused key with a different payload, store and replay the outcome atomically per principal and operation | IETF draft `draft-ietf-httpapi-idempotency-key-header` (draft -08, not an RFC) |
| Concurrency and caching | Strong `ETag` with `If-Match` for lost-update protection, `412` on a stale precondition; explicit `Cache-Control` and `Vary` | RFC 9110 |
| Rate limits | `429` with `Retry-After` and enforced quotas; if you send quota headers, use the draft `RateLimit-Policy` and `RateLimit` fields | IETF draft `draft-ietf-httpapi-ratelimit-headers` (-11) |
| Deprecation | `Deprecation` header (RFC 9745) and `Sunset` header (RFC 8594), a link to migration docs and a published support window | RFC 9745, RFC 8594 |
| Versioning | Additive change first; a URL major version (`/v2`) for public breaking changes; header or media-type versioning only with explicit cache and routing handling; Buf `breaking` rules for protobuf, checking WIRE and WIRE_JSON plus generated-code compatibility | Buf breaking rules |
| Scalars | RFC 3339 UTC timestamps with stated precision; dates as dates; money as a decimal string or integer minor units plus an ISO 4217 currency, never a binary float; opaque string ids that never grant access by being unguessable | RFC 3339, RFC 9562 |
| Long operations | `202 Accepted` with an operation resource (status, result or error, cancel) | AIP-151 |
| gRPC | Status codes plus `google.rpc.Status` details where supported; always set deadlines and propagate cancellation; retry or hedge only safe methods through the service config with budgets and backoff | grpc.io error model, deadlines, service config |
| House style | Pick one guideline set and follow it: Google AIPs, Zalando REST guidelines or Microsoft REST guidelines | - |

## Security baseline

- Delegated user access: OAuth authorization code with PKCE, following the OAuth security BCP (RFC 9700); OAuth 2.1 is still a draft. OpenID Connect for user authentication.
- Service to service: workload identity and mTLS (SPIFFE where available); authenticate the certificate and authorize the identity.
- API keys identify projects, not users: scope them, store them hashed, rotate, revoke and rate-limit them; never ship a privileged key to a browser.
- Map the OWASP API Security Top 10 (2023) to controls:

| Risks | Controls |
| --- | --- |
| API1, API3, API5 broken object, property and function authorization | Authorize every tenant, object, action and field in the domain or repository layer, not only at the gateway; explicit readable and writable fields |
| API2 broken authentication | Validate issuer, audience, signature, algorithm and expiry; rotate credentials; throttle authentication |
| API4, API6 resource consumption and sensitive business flows | Limits on body, decompression, depth, page size, query cost, concurrency and time; per-principal quotas and abuse controls |
| API7 SSRF | Outbound allowlists; block private, link-local and metadata addresses; revalidate DNS and redirects for webhooks |
| API8, API9 misconfiguration and inventory | TLS, explicit CORS origins and credentials, and CSRF protection with cookie auth. Keep an inventory of versions and no debug endpoints in production. CORS does not authorize anyone |
| API10 unsafe API consumption | Validate upstream responses; bounded timeouts and retries; redacted logs with trace correlation |

## Generate code from the contract

| Target | Default | Alternatives | Notes |
| --- | --- | --- | --- |
| TypeScript client | `openapi-typescript` 7 with `openapi-fetch` (types plus a small runtime) | Orval 8 (TanStack Query hooks, mocks); Hey API `@hey-api/openapi-ts` (pre-1.0 plugin system); `oazapfts` | Generated types do not validate responses at runtime |
| Python client | `openapi-python-client` 0.30 | `datamodel-code-generator` 0.95 for models only | Models alone are not an HTTP client |
| Go server and client | `oapi-codegen` v2 | `ogen` (typed client, server and validation) | Code-first alternative: Huma 2 |
| Rust client | `progenitor` 0.16 (OpenAPI 3.0.x) | OpenAPI Generator's `rust` target | Test unions, nullability and `oneOf` |
| Many languages at once | Microsoft Kiota 1 | OpenAPI Generator 7 (Java-based, quality varies per target) | Pin the generator and its templates |
| Public SDKs in several languages | A commercial generator (Speakeasy, Stainless) when you need polished retries, pagination, auth, publishing and support | - | Fern's open-source repository is no longer maintained |
| Protobuf | `buf generate` with pinned local or remote plugins | `protoc` with plugins | Pin plugin versions and BSR module revisions |
| GraphQL | GraphQL Code Generator 8 (TypeScript), `gql.tada` (inferred types), `gqlgen` (Go server), Strawberry (Python, code-first) | - | Check operations as well as the schema |
| AsyncAPI | AsyncAPI CLI 6 `generate`, Modelina for payload models | - | Generated code does not give delivery guarantees |

## Generate schemas from code, and validate against them

| Language | Code to JSON Schema | JSON Schema to types | Validator (2020-12) |
| --- | --- | --- | --- |
| TypeScript | Zod 4 `z.toJSONSchema`; TypeBox 1 (`typebox`, not the legacy `@sinclair/typebox`) | `json-schema-to-typescript` 16; quicktype | Ajv 8 through the `Ajv2020` class; never mix dialects in one instance |
| Python | Pydantic 2 `model_json_schema` (choose validation or serialization mode); msgspec | `datamodel-code-generator` | `jsonschema` 4; `jsonschema-rs` for speed |
| Go | `invopop/jsonschema` (2020-12); Huma | `go-jsonschema` (formerly atombender) | `santhosh-tekuri/jsonschema` |
| Rust | `schemars` 1 | `typify` 0.8 | `jsonschema` crate 0.61 |

Transforms, refinements and custom runtime checks often have no JSON Schema form: test the emitted schema. Choose format assertion and remote `$ref` fetching explicitly in the validator.

## Quality gates and tools

One tool per gate.

| Gate | Default | Alternatives | Where |
| --- | --- | --- | --- |
| OpenAPI lint | Redocly CLI 2 | Spectral 6 (supports OpenAPI 3.2; custom governance rulesets and the OWASP API security ruleset); `vacuum` (fast, Go); IBM `openapi-validator` (OpenAPI 3.0 and 3.1 only) | Pre-commit and CI |
| OpenAPI breaking changes | `oasdiff` against the released baseline | `openapi-diff` (JVM). Optic is archived: do not adopt | CI |
| Bundling and overlays | `redocly bundle` and `redocly split`; a pinned overlay tool (`vacuum apply-overlay`) | `openapi-format` for sorting and filtering | CI |
| Protobuf lint, format, breaking | `buf lint`, `buf format`, `buf breaking` | `api-linter` for Google AIP style; `protolint` | Lint in pre-commit; breaking in CI |
| Protobuf runtime validation | Protovalidate (replaces `protoc-gen-validate`) | - | Code and tests |
| GraphQL | `graphql-eslint` 4 and GraphQL Inspector 7 | Schema checks in Hive (MIT, self-hostable) or Apollo GraphOS | Pre-commit and CI |
| AsyncAPI | AsyncAPI CLI 6 `validate` with Spectral's AsyncAPI rules | EventCatalog for documentation only (BUSL-1.1 licence) | Pre-commit and CI |
| Generated code | Regenerate with the pinned generator and fail on a diff; compile the generated client | - | CI |
| Mock server | Prism 5 (also a validation proxy) | Microcks (OpenAPI, AsyncAPI, protobuf, GraphQL); Mockoon | Local and CI |
| API docs | Scalar | Redoc 3, Swagger UI 5 | Build |
| Contract and property tests | Schemathesis (never against production) | Pact for consumer-driven contracts between independently deployed services. Dredd is archived (2024-11-08): do not adopt | CI |
| HTTP regression tests | Hurl | Bruno, Postman with Newman, StepCI | CI |
| Load | k6 | `ghz` for gRPC; `oha` or `vegeta` for quick HTTP runs | Scheduled |
| gRPC and Connect exploration | `buf curl`, `grpcurl` | Evans | Local |
| Security scan | OWASP ZAP API scan in a disposable environment | Custom cross-tenant authorization tests stay required | Scheduled |

Security rules in a linter check what the document declares, not how the server behaves.

## Rules

1. State the protocol, the contract owner, the version and the support window.
2. Keep one authoritative contract and generate from it reproducibly.
3. Prove tool support with fixtures before moving to a newer spec version.
4. Respect method semantics; standardize errors without leaking internals.
5. Bound every request, query, page and stream.
6. Authorize every tenant, object, action and field.
7. Set deadlines; retry only safe or idempotent operations, with budgets.
8. Make duplicate writes and events harmless; protect concurrent updates.
9. Gate lint, breaking changes, contract tests, authorization tests and load tests in CI.
10. Deprecate explicitly and never change an existing field's wire meaning.

## Sources

- OpenAPI specifications: https://spec.openapis.org/oas/
- Connect protocol and multi-protocol servers: https://connectrpc.com/docs/protocol/, https://connectrpc.com/docs/multi-protocol/
- Spectral: https://github.com/stoplightio/spectral
- Redocly CLI: https://github.com/Redocly/redocly-cli
- oasdiff: https://github.com/oasdiff/oasdiff
- Buf CLI: https://github.com/bufbuild/buf
- Protovalidate: https://github.com/bufbuild/protovalidate
- Kiota: https://github.com/microsoft/kiota
- Ajv JSON Schema 2020-12: https://ajv.js.org/json-schema.html
- AsyncAPI 3.1: https://www.asyncapi.com/docs/reference/specification/latest
- Protobuf editions: https://protobuf.dev/editions/overview/
- gRPC guides: https://grpc.io/docs/guides/
- GraphQL specification: https://spec.graphql.org/
- Standard Webhooks: https://github.com/standard-webhooks/standard-webhooks
- MCP transports: https://modelcontextprotocol.io/specification/latest/basic/transports
- RFC 9110, 9457, 9745, 8594, 9700: https://www.rfc-editor.org/
- Google AIPs: https://google.aip.dev/
- Buf breaking rules: https://buf.build/docs/breaking/rules/
- OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
