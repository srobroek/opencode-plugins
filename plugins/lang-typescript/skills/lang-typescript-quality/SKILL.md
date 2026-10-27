---
name: lang-typescript-quality
description: Use to run TypeScript/JavaScript format, lint and type-check, and for exhaustive unions or trust-boundary validation.
metadata:
  opencode/autoinvoke: false
---

# TypeScript Quality

## Checks

Run the checks through the shell tool from the package root (the directory with
`package.json`). Prefer the project's own scripts (`npm run lint`, `bun run check`,
…) when it defines them; otherwise:

| Step | Command |
| --- | --- |
| Lint | One linter, the first found: project-local Biome (`npx biome check .`), project-local ESLint (`npx eslint .`), then Biome or ESLint on `PATH` |
| Type check | `npx tsc --noEmit` when `tsconfig.json` exists |
| Test | The project's test script (`npm test`, `bun test`, `vitest run`, …) |
| Fix | `npx biome check --write .` or `npx eslint . --fix` |

Use the project's package manager runner (`bunx`, `pnpm exec`, `yarn`) in place of
`npx`, and never let it download a tool the project does not already have.

Fix mode on `.` can rewrite files outside the task. Review the diff and revert
incidental rewrites.

In OpenCode, the built-in `biome`, `prettier` or `oxfmt` formatter rewrites each
file after the `edit`, `write` or `patch` tool changes it when `"formatter": true`
is set in `opencode.json` and the project configures that formatter.

A missing `package.json`, `tsconfig.json` or tool means that step did not run.
Report it as not run, never as a pass. Read failures as the project's actual
toolchain output; do not invent extra linters.

## Type safety

Apply these when writing or reviewing `.ts`, `.tsx` or `.mts` code:

- Derive a string-literal union from the authoritative source (error codes,
  command names, route keys, message ids) rather than hand-maintaining a parallel
  list. Map off it via `Record<Union, () => string>` so a new variant is a
  compile error until handled; use `Partial<Record<…>>` only to override a
  subset.
- Check a runtime allow-list against the union with
  `as const satisfies readonly Union[]`: `satisfies` rejects a member outside the
  union without widening the literal types away, but it does not catch a missing
  member. When the list must cover every variant, derive the union from the list
  (`type Union = (typeof list)[number]`) or key a `Record<Union, true>` off it.
- Apply a schema validator **only** at trust boundaries: external HTTP/IPC
  responses typed `unknown`, query-param and form parsing, config read from disk.
  Re-parsing already-typed internal values costs time and buys no safety.
- Key error messages, UI copy, and notifications off the generated union so a
  missing or mistyped key fails at build time. A runtime i18n library complements
  this; it is not a prerequisite for it.
