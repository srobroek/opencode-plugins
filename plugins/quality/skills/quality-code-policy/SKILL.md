---
name: quality-code-policy
description: "Code policy: SOLID, DRY, tests, research-first reuse of standard libraries, middleware, OTel; load before code changes."
---

# Maintainable code

MUST Load the `quality-code-design` skill (and only its task-relevant references) only for: adding new behavior or a capability, a refactor, a hard bug (root cause not obvious after reading the failure), or a code review. Small edits, mechanical changes, test-only fixes, config, docs and command runs do not need it. Read-only roles stay read-only.

MUST Prioritize SOLID, encapsulation, and protected invariants over YAGNI when they protect a real responsibility or boundary, using the language's own idioms. A library, ORM, or boundary with one consumer is justified when it reduces present total complexity; consumer count alone decides nothing.

MUST Apply DRY to knowledge that must change together, not to code that merely looks alike. Revisit structure whenever behavior changes.

MUST Read flags through one module, decide at the edge, default to existing behavior and choose storage per `quality-code-design`'s `feature-flags.md`.

MUST Before designing or writing code for a concern, research current best practice (official docs, context7, the web) and compare the plan with the preferred-library standards: `lang-<language>-libraries`, `toolchain-api` for API styles, `aws-guidance` for AWS Lambda and service clients, else `toolchain-languages`. Prefer the repository's code, the standard library, the framework's features, then a listed library; write your own only for a named gap, and report each departure from a standard. A dependency the request did not name needs the user's approval.

MUST Put cross-cutting concerns (auth, validation, request ids, logging, tracing, metrics, error mapping, timeouts, retries, rate limits) in the framework's middleware, interceptors or decorators. Use one middleware model per surface: in TypeScript, Hono for HTTP APIs (Lambda included) and Connect for RPC; elsewhere ASGI/FastAPI, `net/http` wrappers or tower. `toolchain-api` compares Connect, gRPC and OpenAPI. Keep AWS Lambda handlers thin. Use Powertools for AWS Lambda in Python, TypeScript, Java and .NET; Go and Rust use their runtime library, a structured logger and manual OTel. Instrument with OpenTelemetry over OTLP by default. `quality-code-design` has the rules in its `middleware.md` and `telemetry.md` references; each `lang-<language>-libraries` skill has the framework and SDK specifics.

MUST Scale planning and verification by uncertainty, consequences, and reversibility; file or line counts decide neither safety nor design. A PR request does not authorize a production release.

MUST Keep tests in step with the code, following the `quality-testing` skill (and `lang-<language>-testing` for idioms and tools): one behavior per test through the public interface, expected values worked out apart from the code, and a distinct risk per test, so search the existing tests and parametrize instead of copying. A refactor leaves tests unchanged; removed behavior takes its tests and fixtures in the same change. Never add a test that only checks removed code is gone, mirrors the implementation, re-checks what the compiler proves or exists for coverage, and never weaken an assertion or update a snapshot just to pass.

MUST After an edit that spans files or changes a signature, run the project's type checker once through the shell before handing back, preferring its own script (`npm run typecheck`); `lang-<language>-quality` names the command.

MUST Refactor only within the requested change: fix the violations it introduces and report pre-existing ones. A major refactor needs the user's approval; a worker reports it to its lead instead of doing it.
