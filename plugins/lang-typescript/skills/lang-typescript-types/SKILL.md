---
name: lang-typescript-types
description: Use for TypeScript type safety (strict tsconfig flags, exhaustive unions, satisfies, zod at boundaries, OpenAPI codegen).
metadata:
  opencode/autoinvoke: false
---

# TypeScript Types

Sources: [TSConfig reference](https://www.typescriptlang.org/tsconfig/), [TypeScript 6.0 release notes](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/), [`satisfies`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator), [Zod 4](https://zod.dev/api), [openapi-typescript](https://openapi-ts.dev/introduction). Examples checked with tsc 7.0 and zod 4.6.

Discriminated unions with `assertNever`, branded types and error causes are in the
`quality-code-design` skill's `typescript.md` reference. This skill is the compiler
settings and the type-level patterns around them. Run the check as in
`lang-typescript-quality`.

## Strict compiler flags

```jsonc
{
  "compilerOptions": {
    "strict": true,                          // the default since TS 6.0; keep it explicit
    "noUncheckedIndexedAccess": true,        // arr[i] and record[key] are T | undefined
    "exactOptionalPropertyTypes": true,      // { retries?: number } rejects { retries: undefined }
    "noImplicitOverride": true,              // subclass methods need `override`
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,            // type-only imports must say `import type`
    "erasableSyntaxOnly": true,              // when Node or Bun runs .ts by stripping types: no enums, namespaces, parameter properties
    "types": ["node"]                        // TS 6.0+ defaults to [], so name the global types you use ("bun", "node", ...)
  }
}
```

- New projects take all of these. On an existing codebase, add one flag at a time,
  fix or count the errors, and land it separately; do not mix flag changes into a
  feature change.
- Never loosen a flag to make a check pass. Suppress a single line with
  `// @ts-expect-error <reason>`, which fails once the error is gone, not
  `// @ts-ignore`.
- Share settings with `"extends"` (an array is allowed) from a repo base config or a
  published base such as `@tsconfig/strictest`.

## Patterns

- Derive a string-literal union from the authoritative source (error codes, command
  names, route keys, message ids) rather than hand-maintaining a parallel list. Map
  off it via `Record<Union, …>` so a new variant is a compile error until handled; use
  `Partial<Record<…>>` only to override a subset.
- Check a runtime allow-list against the union with
  `as const satisfies readonly Union[]`: `satisfies` rejects a member outside the union
  without widening the literal types away, but it does not catch a missing member.
  When the list must cover every variant, derive the union from the list
  (`type Union = (typeof list)[number]`) or key a `Record<Union, true>` off it.
- Prefer `satisfies` to an annotation for config objects and lookup tables: the value
  is checked against the type and keeps its precise literal type.
- Key error messages, UI copy and notifications off the generated union so a missing
  or mistyped key fails at build time.
- `unknown`, not `any`, for values you have not checked; narrow with a type guard
  (`(v: unknown): v is Order`) or a schema. Every `as` and non-null `!` is an unchecked
  claim; keep them inside the one function that proves them.

```ts
const codes = ["not_found", "conflict"] as const
type Code = (typeof codes)[number]
const messages = {
  not_found: "Not found",
  conflict: "Changed by someone else",
} satisfies Record<Code, string>                 // a missing or extra key is an error
```

## Validate at trust boundaries with zod

```ts
import { z } from "zod"

const Order = z.strictObject({                    // unknown keys are an error
  id: z.string().brand<"OrderId">(),
  email: z.email(),                               // zod 4; zod 3 wrote z.string().email()
  lines: z.array(z.object({ sku: z.string(), quantity: z.int().positive() })).min(1),
})
type Order = z.infer<typeof Order>

export function parseOrder(body: unknown): Order {
  const result = Order.safeParse(body)
  if (!result.success) throw new BadRequest(z.prettifyError(result.error))
  return result.data
}
```

Apply a schema **only** at trust boundaries: external HTTP or IPC responses typed
`unknown`, query-param and form parsing, config read from disk, messages from a queue
or storage. Pass the parsed type inward; re-parsing already-typed internal values
costs time and buys no safety. Derive the type from the schema (`z.infer`), never
declare both by hand.

## Types generated from an API schema

```sh
npx openapi-typescript ./openapi.yaml -o ./src/api/schema.d.ts
```

Pair it with `openapi-fetch` (`createClient<paths>()`) for typed requests and
responses. Commit the output and regenerate in CI with a `git diff --exit-code` drift
check (see the `quality-code-design` skill's `contracts.md` reference). Generated types
are compile-time only; still validate responses at runtime when the server is not
yours.
