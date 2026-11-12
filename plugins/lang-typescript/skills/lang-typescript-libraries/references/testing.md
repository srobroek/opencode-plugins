# Testing tools

Choose tests and doubles that exercise the production boundary; commands stay in the quality and testing skills.
See [TypeScript testing practice](../../lang-typescript-testing/references/practice.md) for runner idioms and use-case choices; follow `quality-testing` for the rules.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Unit/async tests | `vitest` `5`; Bun native test runner in Bun projects | Existing runner or Node native tests when already sufficient. | A runner migration for this list alone; unawaited assertions or leaked tasks. |
| Properties | `fast-check` `4` | Table-driven examples for small finite cases. | Random tests without saved seeds/shrunk failures. |
| Snapshots | Existing runner snapshots of small stable public outputs | Explicit assertions when behavior is smaller than its serialized output. | Blind/CI updates or incidental object-graph snapshots. |
| HTTP mocking | `msw` `3` for outbound HTTP only | Hono `app.request()` for handlers; `nock` `15` for existing Node HTTP interception; real server for transport tests. | Assuming Node interception covers Bun native fetch; replacing the handler under test. |
| HTTP recording | Redacted fixtures plus tested replay at the owned boundary | Existing recorder only after checking transport coverage and maintenance. | Default adoption of older recorders without review; captured credentials/PII. |
| Factories | Small project builders; `fishery` `2` when factories are substantial | `@faker-js/faker` `10` for seeded varied data. | Random fixture defaults or global shared mutable fixtures. |
| Integration containers | `testcontainers` `12` | Existing CI service containers or in-process real engine. | Assuming emulator/container startup guarantees production service parity. |
| AWS doubles | `aws-sdk-client-mock` `4` | DynamoDB Local/LocalStack for supported integration cases. | SDK call mocks as evidence of IAM policy or database behavior. |
| Contracts | `@pact-foundation/pact` `17` for consumer/provider contracts | OpenAPI schema/API tests under `toolchain-api` when HTTP schema conformance is the need. | Confusing schemas with consumer behavior; unverified native Pact support on Bun. |
| Browser/E2E | `playwright` `1.65` | Framework/browser test tooling already in the project. | UI snapshots alone for security or network error paths. |
| Load | `k6` `2`, following `toolchain-api` | `autocannon` `9` for quick Node HTTP measurements. | Treating k6 scripts as ordinary Node/Bun programs; hello-world throughput as capacity evidence. |
| API fuzz/contract | `schemathesis` `4` for chosen OpenAPI boundary tests | Pact for consumer/provider contracts. | Archived `dredd` for new work; assuming schema conformance covers tenant authorization. |
| Mutation | `@stryker-mutator/core` `10` with its Vitest runner for selected critical modules | Incremental runs for feedback; verify pinned Vitest compatibility. | Raising coverage with assertion-free tests; treating surviving mutants as automatically harmless. |
| Fuzzing | `fast-check` `4` for generated boundary inputs | `@jazzer.js/core` `4` for supported Node native coverage-guided fuzzing. | Assuming native fuzz tooling supports Bun or all architectures. |
| Benchmarks | `mitata` `1` or `tinybench` `6` | Runtime profiler when diagnosis, not comparison, is needed. | Timing async work without awaiting it; no warm-up or workload equivalence. |
| Coverage | Vitest `v8` on V8; `istanbul` where supported otherwise; native Bun coverage | Branch/changed-line gap review; mutation tests for assertion quality. | Vitest `v8` on Bun; comparing incompatible providers as identical metrics; coverage as correctness. |
| Telemetry | SDK in-memory exporters plus collector smoke test | Actual deployed propagation tests for ADOT/runtime integration. | Mocked SDK imports as proof that instrumentation works. |

## Rules

- Follow `quality-testing`, `lang-typescript-testing` and `lang-typescript-quality` for
  strategy, runner idioms and commands. Test the runtime you deploy, including Bun
  native SQL/fetch/server APIs and Node-native add-ons.
- Unit-test business functions; integration-test parsing, middleware, database and
  broker adapters. Include cancellation, retry, timeout and shutdown failure paths.
- Keep fixtures deterministic. Scrub recordings. Run contract tests against real
  provider behavior. Benchmarks must disclose environment and workload.

## Sources

- [Vitest](https://vitest.dev/guide/), [Bun tests](https://bun.com/docs/test), [fast-check](https://fast-check.dev/).
- [MSW](https://mswjs.io/docs/), [Testcontainers](https://node.testcontainers.org/), [Pact](https://docs.pact.io/implementation_guides/javascript).
- [Stryker](https://stryker-mutator.io/docs/stryker-js/introduction/), [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js), [Playwright](https://playwright.dev/docs/intro).
- [Registry metadata](https://registry.npmjs.org/).
