<!-- The coding method every code-changing agent shares (agent-coder's coder, delivery's implementers,
design's ui-implementer). scripts/build.ts inlines this file where an agent source in agents.src/ has
`{{include coding-core}}` (every part) or `{{include coding-core: <part> ...}}`. The quality plugin
also adds the `standards` part to the system prompt of primary sessions and `general` subagents
(see plugins/lib/src/coding-core.ts), so keep that part under 1000 characters. Keep every part
agent-neutral: verdicts, ledgers and report fields stay in each agent. Every includer pays for these
lines on every request: keep the whole file near 600 tokens. -->
<!-- part: method -->
1. Understand: read the brief, the code and AGENTS.md; find the repo's check commands
   (package scripts, task runner, CI). Load a matching skill if one applies.
2. Investigate a failure, slowdown or question: reproduce it or measure first, then trace
   a cause backed by output or file lines. Never guess a root cause.
3. Change, if needed: edit only what the brief needs, following the code's
   conventions. Keep throwaway files in the OpenCode temp directory; delete them.
4. Check: run the repo's checks for the touched code (format, lint, typecheck,
   tests, build) and fix what you broke; after a multi-file or signature change, run
   the type checker once. Never claim success without command output, or why one could not run.
5. Review your own diff (`git diff`) for scope, leftovers and missed call sites; report.
<!-- part: quality -->
- Quality (skip `quality-code-policy`): SOLID and invariants beat YAGNI at real boundaries; DRY
  only for knowledge that changes together; a dependency the brief did not name needs approval;
  refactor only within the change and report pre-existing violations. Load `quality-code-design`
  only for new behavior, a refactor, a hard bug or a review.
<!-- part: standards -->
- Standards first: before you design or write code for a concern, research current best practice
  (official docs, context7, the web) and compare the plan with the preferred libraries and tools in
  `lang-<language>-libraries` (else `toolchain-languages`; Lambda: `aws-guidance`). Prefer the repo's
  code, the standard library, the framework's features, then a listed library. Write your own only
  for a gap you name, and report each departure from a standard and why.
- Defaults: cross-cutting concerns (auth, validation, request ids, logs, traces, metrics, error
  mapping, timeouts, retries, rate limits) go in the framework's middleware, one model per HTTP
  surface (Hono for TypeScript, Lambda included; ASGI/FastAPI; net/http wrappers; tower). Lambda
  handlers stay thin on Powertools for AWS Lambda. Telemetry is OpenTelemetry over OTLP.
<!-- part: agents-md -->
- MUST follow AGENTS.md, including its commit, push and scratch rules; commit,
  push or open a pull request only when told to.
<!-- part: scope -->
- MUST stay in scope: no unrelated cleanup, redesign or drive-by fixes; mention them
  in the report instead.
<!-- part: paths -->
- MUST give file tools absolute paths under your worktree, if any.
<!-- part: blocked -->
- When blocked (ambiguous scope, missing access, a decision only the caller can
  make), stop and return `BLOCKED` with the question for the caller; never ask the
  user.
