# TypeScript and JavaScript: conditional language guidance

Load only when the task designs, investigates, changes, or reviews TypeScript or JavaScript code. Format, lint, type-check and test commands live in the language plugin's skills when installed.

## Functions and modules before classes

**Do:** use modules, functions, structural types, and discriminated unions for stateless behavior and closed variants; use classes for owned state and lifecycle.
**Do not:** implement a class hierarchy merely to get polymorphism, or mistake static types for runtime input validation.

Bad:

```ts
class UppercaseService { run(value: string) { return value.toUpperCase(); } }
class UppercaseFactory { create() { return new UppercaseService(); } }
```

Good:

```ts
const uppercase = (value: string): string => value.toUpperCase();
```

When locale policy, caching, or I/O is added, reassess responsibilities and dependencies. A callback or explicit options value can still be simpler than an object.

**Exception:** a framework's lifecycle requires an injectable class. Use its normal convention; do not build factories around a class the framework already constructs.

## Closed variants: discriminated unions, checked exhaustively

**Do:** model states as a union with a literal `kind` (or `type`) field, one payload per state, and end every `switch` over it with an exhaustiveness check.
**Do not:** use `status: string` plus optional fields that are only meaningful in some states.

```ts
type Job =
  | { kind: "pending" }
  | { kind: "running"; startedAt: Date }
  | { kind: "finished"; result: JobResult };

function label(job: Job): string {
  switch (job.kind) {
    case "pending": return "queued";
    case "running": return `since ${job.startedAt.toISOString()}`;
    case "finished": return job.result.summary;
    default: return assertNever(job);
  }
}
const assertNever = (value: never): never => { throw new Error(`unhandled: ${JSON.stringify(value)}`); };
```

Why: a new variant becomes a compile error at every switch that forgot it.

## Validated values: branded types

**Do:** give IDs and validated values a brand so a raw `string` cannot be passed where an `OrderId` or `Email` is required. Create them only through a parser. With zod, `.brand()` does both.
**Do not:** cast with `as OrderId` outside the one constructor, or brand values that carry no invariant.

```ts
const Email = z.string().email().brand<"Email">();
type Email = z.infer<typeof Email>;
function invite(to: Email) { /* … */ }
invite(Email.parse(input.email)); // invite(input.email) is a type error
```

Parse at trust boundaries (HTTP, IPC, config, storage) and pass the branded type inward; do not re-parse already-typed internal values.

## Errors keep their cause

**Do:** throw `Error` subclasses (or return a typed result union) with a stable `name` or `code` callers can branch on, and chain the underlying failure with `{ cause }`.
**Do not:** throw strings, rethrow with a new message that drops the original, or catch everything and return `undefined`.

```ts
class ConfigError extends Error { override name = "ConfigError"; }
try { return JSON.parse(await readFile(path, "utf8")); }
catch (error) { throw new ConfigError(`cannot load ${path}`, { cause: error }); }
```

Why: `cause` keeps the original stack for diagnosis while the outer error carries the domain meaning.

**Exception:** at a process or request edge, catching all errors to log and map them to an exit code or response is the correct boundary handling.
