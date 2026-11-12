# Services and HTTP

Choose HTTP frameworks, their middleware, API tooling and content libraries for Node and Bun.

Checked 2026-11-12.

Hono (`hono` `4`) is a Web-Standards HTTP framework: routing, onion middleware,
validators, the typed `hc` client, JSX, streaming and runtime adapters. Middy
(`@middy/core` `7`) is a Lambda invocation middleware engine with `before`, `after`
and `onError` phases; it also handles non-HTTP events. Pino (`pino` `10`) is a
structured JSON logger, not a router or middleware engine. These solve different
problems. Hono replaces neither queue processing nor invocation cleanup; Middy
does not provide Hono's portable application model; Pino does not supply Lambda
context enrichment unless integrated explicitly. See [aws.md](aws.md) for the decision matrix.

Use Hono for every new HTTP surface: `@hono/aws-lambda` on Event Functions,
a native Hono server on Web Functions, and the same app in Node/Bun containers.
One routing/middleware model, built-ins, typed `hc` clients and `app.request()` tests
reduce platform-specific code. Costs: adapter event compatibility and streaming need
tests; Hono has no AWS-event batch/idempotency features, so those remain Powertools.
Never wrap Hono in Middy. Keep existing frameworks unless migration is requested.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| New HTTP API | `hono` `4` | Existing `fastify` `5` or `elysia` `1` services keep their framework. A new Fastify or Elysia service is a departure to report with its gap, for example a required Fastify plugin. | Picking from trivial throughput benchmarks rather than workload/runtime requirements. |
| Existing service | Keep `express` `5`, `koa` `3`, or `@nestjs/core` `12` | Nest for existing DI/module conventions; Express for middleware investment. | Calling these abandoned without evidence; replacing a working framework just for this list. |
| Hono middleware | Built-in `hono/cors`, `hono/secure-headers`, `hono/request-id`, `hono/body-limit`, `hono/timeout`, `hono/compress` in `4` | `hono-rate-limiter` `0.5` with shared storage for distributed quotas. | CORS as authorization; client-supplied request IDs without validation; timeout without cancelling downstream work. |
| Hono tokens | Built-in `hono/jwt` or `hono/jwk` in `4` | `jose` `6` for explicit JOSE/JWKS policy. | Signature-only verification without issuer/audience checks. |
| Fastify middleware | `@fastify/cors` `11`, `@fastify/helmet` `13`, `@fastify/compress` `9`, `@fastify/rate-limit` `11`, `@fastify/jwt` `10` | `@fastify/under-pressure` `9` for overload protection; native request IDs and `bodyLimit` for those concerns. | Mixing async hooks and `done()`; reading body in `onRequest`; incompatible plugin peer ranges. |
| Express middleware | `cors` `2`, `helmet` `8`, `compression` `1`, `express-rate-limit` `8`, `pino-http` `11` | Existing compatible equivalents. Express `5` forwards rejected returned promises to error handlers. | Forgotten error middleware or unreturned async work; process-local quotas across multiple instances. |
| Nest cross-cutting behavior | Middleware, guards, pipes, interceptors in `@nestjs/core` `12` | Guards for authorization; pipes for validation; interceptors for response/lifecycle concerns. | One generic middleware abstraction for all four responsibilities. |
| Validation | `zod` `4` at boundaries | `valibot` `1` for small modular bundles; `arktype` `2` for its schema syntax; `typebox` `1` for JSON Schema-first systems. | Casting network input to a trusted type; replacing `@sinclair/typebox` `0.34` imports without adapter checks. |
| Code-first OpenAPI | `@hono/zod-openapi` `1`; `@fastify/swagger` `9` | `hono-openapi` `1` for Standard Schema integrations. | Publishing untested generated schemas or assuming every tool supports OpenAPI `3.2`. |
| Schema-first clients | `openapi-typescript` `7` | `orval` `8` for query hooks; `@hey-api/openapi-ts` `0.99` for generated SDK workflows. | Handwritten duplicate DTOs when generation fits. |
| API reference UI | `@scalar/hono-api-reference` `0.12` for Hono | Existing documentation UI with verified schema support. | Assuming the UI validates the server's actual behavior. |
| Typed RPC | `@orpc/server` `1` for typed RPC plus public HTTP/OpenAPI | `@trpc/server` `11` for a shared TypeScript stack. | TypeScript-only contracts as the sole public integration surface. |
| Protobuf RPC | `@connectrpc/connect` `2`, `@connectrpc/connect-node` `2`, `@bufbuild/protobuf` `2`, `@bufbuild/protoc-gen-es` `2` | `@grpc/grpc-js` `1` for native-gRPC integrations; matching Fastify adapter in Fastify apps. | Assuming Connect core serves HTTP; assuming Node HTTP/2 behavior on Bun without tests. |
| GraphQL | `graphql-yoga` `6`; `@pothos/core` `4` for code-first schema building | `@apollo/server` `5` for GraphOS; `mercurius` `16` in Fastify. | Apollo Server `4` and earlier: end of support; resolver auth and query-cost limits left implicit. |
| GraphQL clients | `gql.tada` `1` typed documents; `urql` `5` transport/cache | `@apollo/client` `4` for its cache/ecosystem. | Treating typed documents as a network client. |
| WebSockets/SSE | `ws` `8` on Node; Bun native server sockets; Hono streaming helpers in `4` | `socket.io` `4` when rooms/reconnection/protocol features are required. | Treating Socket.IO as raw WebSocket wire compatibility; unbounded buffers. |
| Auth integration | `jose` `6` for token verification; use the existing identity provider | Existing framework auth integration when it handles sessions/OAuth correctly. | Handwritten OAuth, JWT parsing or refresh-token storage. |
| Application sessions/OAuth | `better-auth` `1` when application auth is needed | Existing Auth.js/`next-auth` `4` integrations during planned migration. | Treating token verification as a complete session/OAuth system; Auth.js is now part of Better Auth, not evidence of abandonment. |
| Templates | Hono JSX in `4`; `eta` `4` outside Hono | `handlebars` `4` for existing templates; `react` `19` server rendering for React UI. | Executing untrusted templates or escaping nothing. |
| HTML sanitizing | Server `sanitize-html` `2`; browser `dompurify` `3` | DOMPurify with a current supported DOM implementation for shared code. | Old DOM implementations; mutating output after sanitizing. |
| Markdown | `markdown-it` `15` | `marked` `18` for direct rendering; `micromark` `4` and `remark` `15` for syntax-tree pipelines. | Assuming Markdown output is sanitized HTML. |
| PDF | `playwright` `1.65` for HTML/CSS printing | `pdf-lib` `1` for modifying, forms or merging existing documents. | PDF-lib as an unattended default given its long release gap; unrestricted remote assets/browser navigation. |
| Images | `sharp` `0.35` | Existing platform image service for managed transforms. | Assuming native binary installation works on every Bun/container target; unlimited image dimensions. |
| Email | Provider SDK for delivery; `nodemailer` `10` for SMTP | `react-email` `6` and `@react-email/components` `1` for templates; `@aws-sdk/client-sesv2` `3` for SES delivery. | Treating template rendering as delivery, or retrying sends without deduplication. |

## Rules

- Put cross-cutting concerns in framework middleware/hooks, not copied endpoint code.
  Before instrumented imports, install telemetry. Set correlation/deadlines early.
  Before parsing, enforce size limits. Authenticate before protected business work.
  Validate parsed inputs. Map failures once. Test rejection paths and middleware cleanup.
- Hono middleware enters in registration order and unwinds after `await next()`.
  Hono catches errors, so `next()` does not throw; use `app.onError` for central
  error mapping. Express error middleware has four arguments, is registered last,
  and delegates when headers have already been sent.
  Fastify hooks are lifecycle-specific and encapsulated by plugin scope. Register
  OpenAPI generation before routes when the plugin requires it.
- Accept Standard Schema at reusable schema boundaries when supported. Validation
  interoperability does not guarantee lossless OpenAPI conversion of transforms/refinements.
  Use Buf's `v2` configuration for generation/lint/breaking workflows; this does not
  identify the CLI major. Pin executable/plugins. Verify contract fixtures.
- Middleware cannot make Lambda non-HTTP events into HTTP automatically. Never wrap
  Hono in Middy. Use a small Hono middleware for Lambda context/logging/metrics;
  keep record processing and effect idempotency in Powertools business/event adapters.
- Shared middleware design rules live in `quality-code-design`'s `middleware.md`.
- Use `toolchain-api` for style/specification decisions and API contract test tools.

## Sources

- [Hono concepts and built-ins](https://hono.dev/docs/concepts/middleware), [Lambda](https://hono.dev/docs/getting-started/aws-lambda), [streaming](https://hono.dev/docs/helpers/streaming).
- [Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/), [plugins](https://fastify.dev/docs/latest/Reference/Plugins/), [Swagger](https://github.com/fastify/fastify-swagger).
- [Express error handling](https://expressjs.com/en/guide/error-handling.html), [Nest lifecycle](https://docs.nestjs.com/faq/request-lifecycle).
- [Zod](https://zod.dev/v4), [Connect Node](https://connectrpc.com/docs/node/getting-started/), [Yoga](https://graphql-yoga.com/docs), [Apollo migration](https://www.apollographql.com/docs/apollo-server/migration).
- [DOMPurify](https://github.com/cure53/DOMPurify), [Sharp installation](https://sharp.pixelplumbing.com/install/), [PDF printing](https://playwright.dev/docs/api/class-page#page-pdf).
- [Registry metadata](https://registry.npmjs.org/), [Middy and Powertools](https://middy.js.org/docs/integrations/lambda-powertools).
