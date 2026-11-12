# Middleware: cross-cutting concerns at the boundary

Read when a change touches authentication, coarse authorization, validation, request ids, logging, tracing, metrics, error mapping, timeouts, retries, rate limits, idempotency, CORS, compression, security headers or caching, or when it adds a service, handler, consumer or client. These rules are language-neutral. The mechanism, ordering details and pitfalls for each framework are in the `lang-<language>-libraries` skill's `services.md` (and `aws.md` for Lambda); telemetry rules are in [telemetry.md](telemetry.md); API errors, idempotency keys and rate-limit headers are in the `toolchain-api` skill.

## Handlers hold business logic; middleware holds the rest

**Do:** keep each handler, consumer or command to its business decision: parse and validate input, call a testable domain function, map the result. Compose the concerns above once, at the boundary where they apply, with the framework's middleware, interceptors, hooks, layers or decorators.
**Do not:** repeat auth checks, exception-to-response mapping, timing, logging or retry loops inside each handler, or hand-roll a chain the framework already provides.

Bad: every route handler verifies the token, starts a timer, logs the request and wraps its body in a try block that builds an error response.
Good: one auth middleware or dependency, one telemetry layer, one error mapper; the handler is a few lines of domain logic.

**Exception:** a one-off script or a single function with one concern needs no middleware stack. Resource-level authorization (may this user edit this order?) stays explicit in the route dependency, guard or domain service; middleware authenticates and enforces coarse policy.

## One middleware model per surface

**Do:** use one framework, and so one middleware model, per surface of a service. An HTTP API is one surface, including its Lambda deployment; an RPC API is another (in TypeScript: Hono for the HTTP API, Connect for RPC, each with its own middleware or interceptors). Keep event consumers (queues, streams, schedules) on plain handlers plus the platform's utilities. Share cross-cutting logic between surfaces as plain functions, such as one token verifier and one logger setup, that each surface's chain calls.
**Do not:** wrap one middleware engine in another (an HTTP framework inside a Lambda middleware engine, or an RPC framework inside an HTTP framework without a documented adapter), or run two body parsers, two error mappers or two loggers over the same request.

## Order the stack

Typical inbound order, outermost first; the framework's lifecycle rules override it:

1. Request id and trace-context extraction.
2. Access logging and metrics, so they record the final status.
3. Error mapping, so it catches everything inside it.
4. CORS preflight and security headers.
5. Cheap anonymous abuse limits, then authentication.
6. Identity-based rate limits and quotas.
7. Body-size and decompression limits, then input validation.
8. Timeouts and idempotency.
9. The handler.

Error responses still carry CORS and security headers. Compression must not buffer streams or server-sent events.

## Map errors once

**Do:** translate domain errors to the transport in one place: problem details for HTTP, status codes with details for gRPC, nack or dead-letter decisions for consumers. Keep stack traces and secrets out of responses.
**Do not:** build error bodies in handlers or leak exception text to callers.

## Clients and consumers have middleware too

**Do:** put retries, auth, timeouts and tracing for outbound calls in the HTTP client's transport, interceptor or hook layer, and order them deliberately (auth inside retries, tracing around each attempt). Wrap queue and stream processors so acknowledgement, retry, idempotency and trace-context extraction live in one place.
**Do not:** replay a non-idempotent request without an idempotency key, or acknowledge a message before its side effects are durable.

## Test middleware alone, then assembled

**Do:** test each middleware against a stub downstream handler, then test the assembled stack for ordering, early exits, exceptions, cancellation and streaming. Pass request metadata through typed, namespaced request context.
**Do not:** hide business dependencies in request context, or keep mutable state across requests.

## Sources

- RFC 9457 problem details: https://www.rfc-editor.org/rfc/rfc9457
- gRPC interceptors: https://grpc.io/docs/guides/interceptors/
- OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
