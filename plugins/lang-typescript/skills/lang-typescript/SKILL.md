---
name: lang-typescript
description: "Use for TypeScript/JavaScript work: tsc, lint, bun test or vitest, msw, zod, tsconfig, monorepos, exports, profiling."
---

# TypeScript and JavaScript

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Running TypeScript/JavaScript install, lint, format, `tsc` or `tsc -b` and test checks, locally or in CI | `lang-typescript-quality` |
| Writing or fixing tests: bun test, vitest, module mocks, snapshots, msw, fake timers, fast-check | `lang-typescript-testing` |
| Monorepo and package layout: project references, `exports` maps, barrel files, catalogs, `--define` | `lang-typescript-packaging` |
| Type safety: strict tsconfig flags, exhaustive unions, `satisfies`, zod at trust boundaries, OpenAPI codegen | `lang-typescript-types` |
| Bun or Node profilers and benchmarks: `--cpu-prof`, heap profiles, mitata | `lang-typescript-profiling` |

TypeScript design (functions before classes, discriminated unions, branded types) is the
`quality-code-design` skill's `typescript.md` reference.
