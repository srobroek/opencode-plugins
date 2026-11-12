# TypeScript testing practice
Checked 2026-11-12.
Runner idioms and tool choices for small TypeScript/JavaScript suites.
Follow `quality-testing` for behavior selection, test budget, maintenance, and review.

## Layout and naming

- Do follow existing conventions; otherwise colocate `*.test.ts` with its module.
  Name tests for the condition and caller-visible outcome, not the function name.
- Do separate integration tests when their lifecycle differs. In `Vitest 5`, use
  `projects`, not deprecated `workspace` configuration.
- Do not add another runner to an established suite. Choose `Vitest 5` for fixtures
  and affected-test tooling, `bun test` for Bun products, or `node:test` with
  `node:assert/strict` for dependency-light Node libraries.
- Do not assume Bun has every Vitest fixture, project, or selection API. Bun supports
  concurrency and parallelism; check the APIs required against the pinned runtime.

## One behavior per test

- Do keep arrange, act, and assert visible. Several assertions can describe one result.
  Prefer structural matchers to boolean expressions that hide useful failure diffs.
- Do not combine success, validation, and transport errors in one test.

```ts
import { expect, test } from "vitest"

test("rejects an overdraft without changing the balance", () => {
  const account = openAccount({ balance: 10 })
  expect(() => account.withdraw(11)).toThrow("Insufficient funds")
  expect(account.balance).toBe(10)
})
```

## Parametrize instead of copying

- Do use named object rows when setup, action, and assertion shape match.
  `test.for` preserves the row and supplies test context; `test.each` spreads tuple rows.
- Do not create tables with mode flags and conditional assertions. Keep different
  behaviors separate, even when they exercise the same function.

```ts
test.for([
  { name: "empty input", text: "", expected: [] },
  { name: "one tag", text: "red", expected: ["red"] },
])("parses $name", ({ text, expected }, { expect }) => {
  expect(parseTags(text)).toEqual(expected)
})
```

## Fixtures and builders

- Do start with local plain factories returning fresh objects, including nested data.
  Share construction in the nearest `test-support` module only when several tests need it.
  Use `fishery 2` for substantial typed factories, not for two simple defaults.
- Do use `test.extend` for explicit Vitest fixtures with paired acquisition and teardown.
  Prefer test-scoped mutable resources; use worker scope only for safe shared resources.
- Do not hide behavioral inputs in global setup, automatic fixtures, or broad hooks.
  Do not reuse a mutable account or array across tests.
- Do keep `@faker-js/faker 10` optional. Seed it, fix time-dependent inputs, and override
  assertion-relevant fields; generated realistic data does not replace boundary cases.

```ts
const anOrder = (overrides: Partial<Order> = {}): Order => ({
  id: "order-1", total: 20, lines: [], ...overrides,
})
const freeOrder = anOrder({ total: 0 })
```

## Doubles

- Do use real deterministic collaborators, then small interface-conforming fakes.
  Use `vi.fn` or `vi.spyOn` at owned boundaries; restore spies after each test.
- Do not mock the behavior under test or assert private calls. Clearing call history,
  resetting implementations, and restoring original methods are different operations.
- Do remember `vi.mock` is hoisted: factories cannot capture ordinary later-initialized
  variables. Use `vi.hoisted` for required shared mock state, or inject the dependency.
  `vi.doMock` affects subsequent imports, not existing static imports; `vi.mock` does
  not intercept `require()`. Setup-file imports may already have cached the real module.
- Do register Bun `mock.module` replacements before side-effectful imports, optionally
  in preload. Replacing imported bindings cannot undo import-time side effects.
  `mock.restore()` leaves module replacements in place; isolate files as described in
  this skill's runner commands rather than sharing uncontrolled replacements.
- Do use `msw 3` only for outbound HTTP, with unexpected requests failing, per-test
  handler resets, and server cleanup. It is ESM-only and requires `Node >=22` and
  `TypeScript >=5.9`; verify interception under Bun rather than assuming Node parity.
- Do execute actual handlers: for Hono, `app.request()` exercises routing and middleware
  without a listening server. Do not replace the handler with an MSW response.

```ts
test("returns a missing-user response", async () => {
  const response = await app.request("/users/missing")
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: "User not found" })
})
```

## Async, time, and concurrency

- Do await operations and rejection assertions. Inject clocks into pure time logic;
  use Vitest fake timers to drive timer-based behavior, then restore real timers.
- Do not sleep to wait for work. Await a completion signal or advance the relevant timer.
  Bun's `setSystemTime` controls the clock; do not assume Vitest timer API parity.
- Do use concurrent tests only with independent resources and context-local `expect`,
  especially for snapshots. Do not concurrently mutate global clocks or MSW handlers.

```ts
test("expires after the deadline", async () => {
  vi.useFakeTimers()
  try {
    const pending = waitForExpiry(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe("expired")
  } finally {
    vi.useRealTimers()
  }
})
```

## Property tests

- Do use `fast-check 4` for round-trips, idempotence, conservation, or a reference model
  when one independent property replaces repetitive examples.
- Do await `fc.assert(fc.asyncProperty(...))` for async code. Create/reset state for
  every generated execution, not just once in the surrounding runner test.
- Do retain the failing seed/path for replay and promote important shrunk failures to
  named regression examples. Do not reproduce production computation as the oracle.

```ts
test("round-trips every supported label", () => {
  fc.assert(fc.property(fc.string(), label => decode(encode(label)) === label))
})
```

## Snapshots

- Do use inline snapshots for tiny outputs; use external snapshots or awaited
  `toMatchFileSnapshot` for short stable serialized artifacts needing their own file.
  Project only the public output; control IDs, time, and ordering deliberately.
- Do review every update as an assertion change. Do not auto-update in CI, snapshot
  incidental object graphs, or add full equality beside an identical snapshot.

## Fuzzing, mutation testing, and coverage

- Do start with properties for domain invariants. Use `@jazzer.js/core 4` selectively
  on Node for hostile parser inputs and crash/security boundaries; retain minimized
  failures. Do not assume Jazzer.js supports Bun.
- Do use `@stryker-mutator/core 10` with `@stryker-mutator/vitest-runner 10` on selected
  critical logic. Inspect meaningful survivors rather than enforce a universal score.
  The peer range accepts `Vitest 5`, but that is not an executed compatibility test.
- Do use Stryker incremental results for feedback and periodically run without the
  cache. Restrict mutation to changed source when appropriate, not the entire repo.
- Do measure uncovered branches and changed lines as gap finders, not correctness.
  Vitest's default `v8` provider needs V8 and does not work on Bun; choose `istanbul`
  for non-V8 Vitest coverage where supported, or Bun's native coverage for Bun tests.
- Do use `vitest run --changed` or `vitest related --run <source>` for fast feedback.
  Related selection follows static imports, not computed dynamic imports.
  `Vitest 5.1` has experimental `--since-last-run` selection from previously loaded
  dependencies. Do not confuse affected-test selection with changed-line coverage;
  retain the full CI suite and review LCOV/diff coverage separately.

## Flaky tests

- Do keep `retry: 0` by default. Diagnose Vitest failures with `repeats`,
  `sequence.shuffle`, and a recorded `sequence.seed`; use Bun randomization/reruns
  when Bun is the runner. Repeat with isolated resources before enabling concurrency.
- Do investigate leaked mocks, timers, randomness, and resource collisions.
  Quarantine only with an issue, owner, expiry, and a separate reporting lane.
- Do not make failures green with blanket retries or permanent skips.

## Bad tests and fixes

See the `quality-testing` skill's `references/bad-tests.md` for language-neutral pairs covering removal checks, copied oracles, call-order mocks, side channels, copies instead of parameters, logic in tests, sleeps, assertion-free tests, eager tests, mystery guests, type re-checks, tampering, and whole-object snapshots.

### Automocking the pricing behavior

Bad:

```ts
import { priceOrder } from "./pricing"
vi.mock("./pricing")
test("adds shipping to the quoted price", async () => {
  vi.mocked(priceOrder).mockResolvedValue(25)
  expect(await priceOrder("order-1")).toBe(25)
})
```

This checks the configured mock rather than the pricing module's calculation.

Fix:

```ts
import { priceOrder } from "./pricing"
test("adds shipping to the quoted price", async () => {
  const http = { get: async (_url: string) => ({ price: 20 }) }
  expect(await priceOrder("order-1", http)).toBe(25)
})
```

### Unawaited rejection assertions

Bad:

```ts
test("rejects an expired token", () => {
  expect(authenticate("expired")).rejects.toThrow("Expired token")
})
```

The test does not wait for its assertion; `Vitest 5` fails unawaited async assertions instead of allowing a false pass.

Fix:

```ts
test("rejects an expired token", async () => {
  await expect(authenticate("expired")).rejects.toThrow("Expired token")
})
```

### Frozen timers without restoration

Bad:

```ts
test("expires after the deadline", async () => {
  vi.useFakeTimers()
  await expect(waitForExpiry(1000)).resolves.toBe("expired")
})
```

The timer never advances, so the test hangs until timeout and leaves fake timers active for later tests.

Fix:

```ts
afterEach(() => vi.useRealTimers())
test("expires after the deadline", async () => {
  vi.useFakeTimers()
  const pending = waitForExpiry(1000)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(pending).resolves.toBe("expired")
})
```

## Do not write

- Do delete obsolete tests with removed behavior. Do not replace them with structural
  absence assertions such as `expect(mod.oldFn).toBeUndefined()` or
  `await expect(import("./deleted-module")).rejects.toThrow()`.
- Do run `tsc` for assignability, required fields, and exhaustiveness. Do not add runtime
  tests that re-check what `tsc` proves. Dedicated public type-contract tests are a
  separate need; runtime validation of untrusted input still needs behavioral tests.
- Do not test trivial getters, private helpers, mirrored computations, or a second
  copy of a case covered at another level without a distinct risk.
  Packaging, security exclusions, and API compatibility can justify contract tests;
  test the consumer outcome, not a refactor's deleted internals.

## Defaults by use case

| Use case | Start with | Add only for a distinct risk |
| --- | --- | --- |
| Pure logic | Existing runner, named `for`/`each` cases | `fast-check` invariants; no module mocks |
| I/O adapters | Fresh temporary resources, injected fakes | Real boundary integration; narrow spy |
| HTTP handlers | Hono `app.request()` or framework equivalent | MSW for outbound HTTP; server smoke test for transport |
| Async/concurrency | Awaited work, isolated resources, injected clock | Fake timers; cancellation and race scenarios |
| CLI | Direct command function with injected streams | Small subprocess exit/output smoke test |
| Parsers | Named valid/malformed cases, round-trip property | Node Jazzer.js for hostile byte inputs |
| CI lane | Full suite, typecheck, branch/changed-line gap review | Periodic shuffle/repeats; targeted Stryker |

## Sources
- [Vitest test APIs](https://vitest.dev/api/test), [projects](https://vitest.dev/guide/projects), [selection](https://vitest.dev/guide/cli), [5.1](https://vitest.dev/blog/vitest-5-1).
- [Vitest mocking/time](https://vitest.dev/api/vi), [snapshots](https://vitest.dev/guide/snapshot), [coverage](https://vitest.dev/guide/coverage), [sequence](https://vitest.dev/config/sequence).
- [Bun tests](https://bun.sh/docs/test), [module mocks](https://bun.sh/docs/test/mocks), [Node tests](https://nodejs.org/api/test.html).
- [Fishery](https://github.com/thoughtbot/fishery), [Faker](https://fakerjs.dev/guide/), [fast-check properties](https://fast-check.dev/docs/core-blocks/properties/).
- [MSW Node integration](https://mswjs.io/docs/integrations/node/), [MSW releases](https://github.com/mswjs/msw/releases), [Hono testing](https://hono.dev/docs/guides/testing).
- [Stryker Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/), [incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/), [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js).
