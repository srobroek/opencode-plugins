# Testing tools

Choose tests and doubles that exercise the production boundary; commands stay in the quality and testing skills.
See [TypeScript testing practice](../../lang-typescript-testing/references/practice.md) for runner idioms and use-case choices, [quality.md](quality.md) for lint, types, audit, API breaks and docs; follow `quality-testing` for the rules.
Follow the install policy in `toolchain-languages` `concerns.md`: detect with the first command, recommend the install command, and ask before you add a dependency. Install commands use `npm i -D`; use the project's package manager equivalent (`bun add -d`, `pnpm add -D`).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `vitest`, run once with `vitest run` and `--reporter=junit` for CI | >= 5.1.0 · 2026-11-02 · active | `node_modules/.bin/vitest --version` · `npm i -D vitest` | bun test: the project runs on Bun, with `--reporter=junit`; `node:test`: a dependency-free Node library | - | every-pr | A second runner in one project, bare `vitest`, which starts watch mode; a runner migration for this table alone; tests that find no tests reported as a pass |
| `assertions` | Built-in: the runner's `expect` (Vitest `expect`, `bun:test` `expect`) | - | Built-in | `@testing-library/jest-dom`: DOM tests (7.0.1, 2026-08-09, MIT); `chai`: Mocha suites or existing chai code (6.3.0, 2026-09-30, MIT, ESM-only); `node:assert`: node:test or dependency-free libraries | - | every-pr | `should.js` (stale since 2018), `unexpected` (low activity); `chai-as-promised` where `expect(...).resolves` or `.rejects` works; `expect-type` under Vitest, which has `expectTypeOf` built in (use `expect-type` only for other runners) |
| `watch` | Built-in: `vitest watch` (the default in a TTY) and `vitest --changed [since]` for test selection | - | Built-in | `bun test --watch`: Bun projects | - | on-demand | Bare `vitest` in CI or a script: it starts watch mode and never exits |
| `property` | `fast-check`; seed with `fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 100) })` | >= 4.10.2 · 2026-09-19 · active | `npm ls fast-check --depth=0` · `npm i -D fast-check` | None | `@fast-check/vitest` (0.5, pre-1.0) for `test.prop` in Vitest; plain `fc.assert` needs no adapter in bun:test | every-pr | Random tests without a saved `{ seed, path }` and a named regression example; recomputing the code under test as the oracle |
| `fuzz` | `@jazzer.js/core` on Node LTS, run as `npx jazzer fuzz/parse.fuzz.js corpus/ --sync -- -max_total_time=60` | >= 4.0.0 · 2026-04-15 · active | `npm ls @jazzer.js/core --depth=0` · `npm i -D @jazzer.js/core` | fast-check: Bun-only CI or hosts without a native addon build, with `fc.uint8Array()` and a high `numRuns` on a schedule, which is not coverage-guided | `fast-check` properties for normal suites and Jazzer.js for hostile bytes | bounded-pr | Running Jazzer.js under Bun: it is a native libFuzzer addon and supports no other runtime; `jsfuzz` (stale); discarding the corpus or failing inputs |
| `fuzz-continuous` | Shared: oss-fuzz | - | Shared | scheduled Jazzer job: closed-source projects, with the corpus cached between runs | the OSS-Fuzz project builds the same Jazzer.js targets as the PR job | scheduled | Claiming ClusterFuzzLite supports JavaScript: it does not; long campaigns in the PR job |
| `mutation` | `@stryker-mutator/core` with `@stryker-mutator/vitest-runner`, emitting `--reporters json` | >= 10.1.1 · 2026-10-23 · active | `node_modules/.bin/stryker --version` · `npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner` | @hughescr/stryker-bun-runner: Bun projects that accept a single-maintainer runner, pinned (1.6.0, 2026-10-13, needs Bun 1.4, Node 22 and TypeScript below 7, Linux or macOS); stryker command runner: Bun projects without that runner, using `testRunner: "command"` with `bun test --bail` | - | diff-pr + scheduled | A whole-repo PR gate: use `--mutate` on changed files with incremental mode on PRs and the full run on a schedule; the Vitest runner forces `maxWorkers` 1; `mock.module()` of a mutated file has no effect under the Bun runner; comparing scores across tools |
| `snapshot` | Built-in: the runner's snapshots (Vitest, bun test) of small stable public output | - | Built-in | None | - | every-pr | Updating snapshots in CI or in bulk without review; whole object graphs with ids, time or ordering |
| `component` | `@vitest/browser-playwright`, Vitest browser mode with the Playwright provider, plus Testing Library (`@testing-library/dom` 10.4.2, `@testing-library/react` 16.3.3, `@testing-library/user-event` 14.6.12, MIT) | >= 5.1.0 · 2026-11-02 · active | `npm ls @vitest/browser-playwright --depth=0` · `npm i -D @vitest/browser-playwright @testing-library/dom @testing-library/user-event` | `jsdom`: layout and CSS do not matter; `happy-dom`: the same, with a faster DOM; `@storybook/addon-vitest`: the project uses Storybook (10.6.7, the Storybook test-runner 0.26.0 appears superseded, unverified) | - | every-pr | Playwright component testing (`@playwright/experimental-ct-*` is stuck at 1.62.1; the new mount-fixture design's status is unverified); asserting on implementation details instead of roles and text |
| `concurrency` | No maintained tool: injected clocks, fake timers, awaited work, shuffled and repeated runs | - | - | None | - | - | Sleeping to wait for work; reading a green parallel run as race safety; concurrent tests that mutate a global clock or MSW handlers; Bun `--parallel` and `--isolate` expose shared state, they do not prove its absence |
| `coverage` | `@vitest/coverage-v8` with `vitest run --coverage` and an lcov reporter | >= 5.1.0 · 2026-11-02 · active | `npm ls @vitest/coverage-v8 --depth=0` · `npm i -D @vitest/coverage-v8` | bun test --coverage: Bun test projects, with `--coverage-reporter=lcov`, lines and functions only and no branches, thresholds via `coverageThreshold`; @vitest/coverage-istanbul: branch data from a non-V8 engine, per-file instrumentation limits, or a Bun older than 1.4 | mutation runs (`mutation` row) for assertion quality beside coverage | every-pr | Coverage as a target or correctness evidence; comparing providers as the same metric; Vitest `v8` on Bun older than 1.4 |
| `benchmark` | `tinybench` | >= 6.2.3 · 2026-11-01 · active | `npm ls tinybench --depth=0` · `npm i -D tinybench` | vitest bench: Vitest projects that want benchmarks beside tests; mitata: micro-benchmarks with its report format (1.0.34, last release 2025-02-04); CodSpeed: managed CI trend tracking | - | on-demand | Timing async work without awaiting it; no warm-up; noisy shared-runner timings as hard guarantees |
| `flaky-order` | `vitest` with `--sequence.shuffle`, a recorded `--sequence.seed` and `repeats` | >= 5.1.0 · 2026-11-02 · active | `node_modules/.bin/vitest --version` · `npm i -D vitest` | bun test: the project runs on Bun, with `--randomize`, `--seed` and `--rerun-each` | - | scheduled | Blanket retries that mask failures; quarantine without an owner and expiry; shuffling files but not tests |
| `integration` | Shared: testcontainers | - | Shared | compose or CI service containers: a long-lived stack shared by many test processes | - | every-pr | Reading emulator or container startup as production parity; hard-coded host ports; Bun support is unverified, so run these under Node |
| `contract` | Shared: contracts | - | Shared | `@pact-foundation/pact`: two or more services you own call each other and deploy independently (17.1.4, a Pact Broker is required, run under Node 22 or later on glibc) | `oasdiff` when the provider also publishes an OpenAPI spec | every-pr | Pact as the only gate for public APIs; schemas confused with consumer behavior; running Pact under Bun or Alpine |
| `api-schema` | Shared: schemathesis | - | Shared | None | `hurl` for a few hand-written requests | every-pr | Destructive generated tests against production; `dredd` for new work; schema conformance read as tenant authorization |
| `load` | Shared: k6 | - | Shared | autocannon: a quick Node HTTP measurement (>= 9.0) | - | scheduled | Treating k6 scripts as Node or Bun programs; hello-world throughput as capacity evidence |

## Tradeoffs

### test-runner

- **vitest**: wins on projects, fixtures, shuffled and seeded runs, JUnit output and browser mode in one runner; costs a Node-side dependency tree and a watch-mode default that hangs in CI unless run as `vitest run`.
- **bun test**: wins when the product runs on Bun and one runtime for build, run and test matters; costs fewer fixture, project and selection APIs than Vitest. Module mocks leak across files unless isolated, and coverage has no branches.
- **node:test**: wins when a Node library wants no test dependency and `node:assert/strict`; costs no built-in coverage thresholds, projects or watch-mode ergonomics comparable to Vitest.

### assertions

- **@testing-library/jest-dom**: wins on readable DOM matchers in component tests; costs a second matcher set to register with the runner.
- **chai**: wins when a Mocha suite or existing chai code is in place; costs a second assertion style and ESM-only loading.
- **node:assert**: wins under node:test or in a dependency-free library; costs no asymmetric matchers or rich diffs comparable to `expect`.

### component

- **@vitest/browser-playwright**: wins on real browser layout, events and CSS in the same Vitest run as unit tests; costs a Playwright browser install and slower runs than jsdom.
- **jsdom**: wins on speed and no browser install when layout and CSS do not matter; costs no layout, and some browser APIs are missing.
- **happy-dom**: wins on the fastest startup for the same cases; costs more behavior gaps against real browsers than jsdom.
- **@storybook/addon-vitest**: wins when stories already exist and double as tests; costs Storybook in the toolchain.

### mutation

- **@stryker-mutator/core**: wins on the most mature JS mutation engine with incremental mode, a Vitest runner and JSON reports; costs slow runs on large suites and `maxWorkers` 1 under the Vitest runner.
- **@hughescr/stryker-bun-runner**: wins when Bun is the runner and per-test coverage keeps mutant runs fast; costs a single maintainer, serial test runs, and a `mock.module()` blind spot.
- **stryker command runner**: wins when nothing beyond Stryker itself should be trusted; costs `coverageAnalysis: "off"`, so every mutant runs the whole suite.

### coverage

- **@vitest/coverage-v8**: wins on fast native V8 coverage with Istanbul-identical reports since Vitest 3.2 and no instrumentation step; costs Bun support that depends on the Bun version.
- **bun test --coverage**: wins when the suite already runs on `bun test` and lines and functions are enough; costs no branch data. `bun --bun vitest run --coverage` with `v8` also works on Bun 1.4 or later by Bun's account, while the Vitest docs still say `v8` does not work on Bun.
- **@vitest/coverage-istanbul**: wins when branch data must come from a non-V8 engine or an older Bun runs the suite; costs per-file instrumentation and slower runs than `v8`, which since Vitest 3.2 gives Istanbul-identical reports.

### benchmark

- **tinybench**: wins on a small runtime-agnostic API with warm-up and statistics that runs under Node and Bun; costs no baseline storage or CI trend tracking.
- **vitest bench**: wins when the suite already uses Vitest and benchmarks sit beside the tests; costs the same noise on shared runners.
- **mitata**: wins when you want its report format and fine-grained timing; costs a release line stale since 2025-02-04.
- **CodSpeed**: wins when CI needs managed regression trends; costs a hosted service.

## Language-specific

| Topic | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| HTTP mocking | `msw` `>= 3` for outbound HTTP only | Hono `app.request()` for handlers; `nock` `>= 15` for existing Node HTTP interception; real server for transport tests | Assuming Node interception covers Bun native fetch; replacing the handler under test |
| HTTP recording | Redacted fixtures plus tested replay at the owned boundary | Existing recorder only after checking transport coverage and maintenance | Default adoption of older recorders without review; captured credentials or PII |
| Factories | Small project builders; `fishery` `>= 2` when factories are substantial | `@faker-js/faker` `>= 10` for seeded varied data | Random fixture defaults or global shared mutable fixtures |
| AWS doubles | `aws-sdk-client-mock` `>= 4` | DynamoDB Local or LocalStack for supported integration cases | SDK call mocks as evidence of IAM policy or database behavior |
| Browser and E2E | See the `toolchain-languages` skill's `references/surfaces.md` for E2E, visual and accessibility checks | Playwright runs under Node even in Bun repos | UI snapshots alone for security or network error paths |
| Type behaviour tests | `expect-type` via `vitest --typecheck` for specific public type behaviours | `tsc` alone when assignability is the only claim | Runtime tests that re-check what the compiler proves |
| Telemetry | SDK in-memory exporters plus a collector smoke test | Deployed propagation tests for ADOT or runtime integration | Mocked SDK imports as proof that instrumentation works |

## Rules

- Follow `quality-testing`, `lang-typescript-testing` and `lang-typescript-quality` for
  strategy, runner idioms and commands. Test the runtime you deploy, including Bun
  native SQL, fetch and server APIs and Node-native add-ons.
- One runner per project. Run fuzz targets on Node even in a Bun project.
- Unit-test business functions; integration-test parsing, middleware, database and
  broker adapters. Include cancellation, retry, timeout and shutdown failure paths.
- Keep fixtures deterministic. Scrub recordings. Run contract tests against real
  provider behavior. Benchmarks must disclose environment and workload.

## Sources

- [Vitest](https://vitest.dev/guide/), [Bun tests](https://bun.com/docs/test), [Node tests](https://nodejs.org/api/test.html), [fast-check](https://fast-check.dev/).
- [MSW](https://mswjs.io/docs/), [Testcontainers](https://node.testcontainers.org/), [Pact](https://docs.pact.io/implementation_guides/javascript).
- [Stryker](https://stryker-mutator.io/docs/stryker-js/introduction/), [Bun runner for Stryker](https://www.npmjs.com/package/@hughescr/stryker-bun-runner), [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js), [Vitest coverage](https://vitest.dev/guide/coverage), [Bun coverage](https://bun.com/docs/test/coverage).
- [tinybench](https://github.com/tinylibs/tinybench), [Playwright](https://playwright.dev/docs/intro), [expect-type](https://github.com/mmkal/expect-type), [Registry metadata](https://registry.npmjs.org/).
