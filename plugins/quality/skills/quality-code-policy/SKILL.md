---
name: quality-code-policy
description: "Code policy: SOLID, DRY, research-first reuse of standard libraries, middleware, OTel; load before code changes."
---

# Maintainable code

MUST Load the `quality-code-design` skill (and only its task-relevant references) only for: adding new behavior or a capability, a refactor, a hard bug (root cause not obvious after reading the failure), or a code review. Small edits, mechanical changes, test-only fixes, config, docs and command runs do not need it. Read-only roles stay read-only.

MUST Prioritize SOLID, encapsulation, and protected invariants over YAGNI when they protect a real responsibility or boundary, using the language's own idioms. A library, ORM, or boundary with one consumer is justified when it reduces present total complexity; consumer count alone decides nothing.

MUST Apply DRY to knowledge that must change together, not to code that merely looks alike. Revisit structure whenever behavior changes.

MUST Before designing or writing code for a concern, research current best practice (official docs, context7, the web) and compare the plan with the preferred-library standards: `lang-<language>-libraries`, `toolchain-api` for API styles, `aws-guidance` for AWS Lambda and service clients, else `toolchain-languages`. Prefer the repository's code, the standard library, the framework's features, then a listed library; write your own only for a named gap, and report each departure from a standard. A dependency the request did not name needs the user's approval.

MUST Put cross-cutting concerns (auth, validation, request ids, logging, tracing, metrics, error mapping, timeouts, retries, rate limits) in the framework's middleware, interceptors or decorators, with one middleware model per HTTP surface (Hono for TypeScript HTTP, Lambda included; ASGI/FastAPI; `net/http` wrappers; tower). Keep AWS Lambda handlers thin on Powertools for AWS Lambda, and instrument with OpenTelemetry over OTLP by default. `quality-code-design` has the rules in its `middleware.md` and `telemetry.md` references; each `lang-<language>-libraries` skill has the framework and SDK specifics.

MUST Scale planning and verification by uncertainty, consequences, and reversibility; file or line counts decide neither safety nor design. A PR request does not authorize a production release.

MUST After an edit that spans files or changes a signature, run the project's type checker once through the shell before handing back, preferring its own script (`npm run typecheck`); `lang-<language>-quality` names the command.

MUST Refactor only within the requested change: fix the violations it introduces and report pre-existing ones. A major refactor needs the user's approval; a worker reports it to its lead instead of doing it.
