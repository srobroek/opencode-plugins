---
name: lang-typescript-testing
description: Use to write or fix TypeScript/JavaScript tests (bun test, vitest, module mocks, snapshots, msw, fake timers, fast-check).
metadata:
  opencode/autoinvoke: false
---

# TypeScript Testing

Sources: [bun test](https://bun.com/docs/test) ([mocks](https://bun.com/docs/test/mocks), [snapshots](https://bun.com/docs/test/snapshots), [dates and times](https://bun.com/docs/test/time)), [Vitest module mocking](https://vitest.dev/guide/mocking/modules) and [snapshots](https://vitest.dev/guide/snapshot), [MSW in Node](https://mswjs.io/docs/integrations/node), [fast-check](https://fast-check.dev/). Checked with Bun 1.4.3, Vitest 5.0, msw 2 and 3, fast-check 4.

What to test and which double to use is the `quality-testing` skill. This skill is the
runner idioms. Use the runner the project already has (`bun test`, `vitest`, `jest`,
`node --test`); do not add a second one.

## Running

```sh
bun test --bail                              # stop at the first failure
bun test src/orders -t "refund"              # path filter plus test-name regex
bun test --isolate                           # fresh globals and module registry per file
bun test --coverage
vitest run --bail=1                          # vitest: run once, no watch
vitest run src/orders -t "refund"
vitest run --coverage
```

`vitest` without `run` starts watch mode and never exits; in checks always use
`vitest run`.

## Module mocks

Prefer passing a dependency in (a parameter, an options object) over mocking a
module. When a module mock is the only way:

```ts
// bun
import { mock, test, expect } from "bun:test"
mock.module("./mailer.ts", () => ({ send: mock(async () => ({ id: "m1" })) }))
const { notify } = await import("./notify.ts")   // import after mocking
```

```ts
// vitest: vi.mock is hoisted above the imports
import { vi, test, expect } from "vitest"
import { notify } from "./notify.ts"
vi.mock(import("./mailer.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  send: vi.fn(async () => ({ id: "m1" })),
}))
```

- Bun runs all test files in one process by default, and `mock.restore()` does not undo
  `mock.module()`. A module mock in one file leaks into every file that runs after it:
  a test that passes alone fails in the full run. Run with `bun test --isolate` (or
  `--parallel`, which implies it), or put shared mocks in a `--preload` file.
- Bun evaluates the real module before a `mock.module()` call that comes after its
  import; its side effects have already run. Mock in a preload, or import the subject
  dynamically after mocking.
- Restore spies after each test: `afterEach(() => mock.restore())` in Bun,
  `restoreMocks: true` in the Vitest config.

## HTTP with MSW

```ts
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

const server = setupServer(
  http.get("https://api.example.com/users/:id", ({ params }) => HttpResponse.json({ id: params.id })),
)
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))   // unmocked request = test failure
afterEach(() => server.resetHandlers())                            // drop per-test overrides
afterAll(() => server.close())

test("surfaces a 500", async () => {
  server.use(http.get("https://api.example.com/users/:id", () => new HttpResponse(null, { status: 500 })))
  await expect(getUser("7")).rejects.toThrow(/500/)
})
```

MSW intercepts at the network layer, so the real client code (headers, retries,
parsing) runs. msw 3.0.3 did not intercept under Bun 1.4.3 (`Failed to replace a global
value`) while msw 2 did, and msw 3 works under Node; pin msw 2 in Bun projects until that
is fixed.

## Snapshots

- Snapshot only stable, reviewable output: rendered text, generated code, error
  messages. Never snapshot whole objects with timestamps, ids or ordering you do not
  control; assert the fields that matter instead.
- Prefer `toMatchInlineSnapshot()` for small values, so the expectation sits in the test.
- Update deliberately (`bun test --update-snapshots`, `vitest run -u`) and read the
  snapshot diff like code. Both runners refuse to write new snapshots in CI, so a
  missing snapshot fails there instead of being recorded.

## Time and property tests

```ts
import { setSystemTime } from "bun:test"           // vitest: vi.useFakeTimers(); vi.setSystemTime(...)
setSystemTime(new Date("2026-01-01T00:00:00Z"))
// ...
setSystemTime()                                     // back to the real clock
```

Inject a clock into code that reads time when you can; fake timers are for code you
cannot change. For invariants over many inputs, use fast-check:

```ts
import fc from "fast-check"
test("round-trips", () => {
  fc.assert(fc.property(fc.string(), (s) => decode(encode(s)) === s))
})
```

On failure fast-check prints the shrunk counterexample and a `seed`; add that input as
an ordinary test case.
