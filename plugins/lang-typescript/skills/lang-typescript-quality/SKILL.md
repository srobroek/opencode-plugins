---
name: lang-typescript-quality
description: Use to run TypeScript/JavaScript install, lint, format, tsc or tsc -b, and test checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
---

# TypeScript Quality

Sources: [tsc CLI](https://www.typescriptlang.org/docs/handbook/compiler-options.html) and [project references](https://www.typescriptlang.org/docs/handbook/project-references.html) (checked with tsc 7.0), [`bun --filter`](https://bun.com/docs/pm/filter), [pnpm filtering](https://pnpm.io/filtering), [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces), [Biome CLI](https://biomejs.dev/reference/cli/).

Run the checks through the shell tool from the package or workspace root (the
directory with `package.json`), in this order. Stop at the first failing step, fix
it, rerun that step, then continue. Prefer the project's own scripts (`bun run check`,
`npm run lint`, …) when it defines them; otherwise:

| Step | Command |
| --- | --- |
| Install | The lockfile-respecting install: `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `npm ci`, `yarn install --immutable` |
| Lint and format check | Biome first: `biome check .` covers lint, format and import sorting. `ESLint` 10 flat config (`eslint .`) or `Prettier` (`prettier --check .`) only for a named gap, such as type-aware rules Biome lacks, Vue or Angular templates |
| Type check | `tsc -b` when `tsconfig.json` has `references`, otherwise `tsc --noEmit` |
| Test | The project's test script (`bun test`, `vitest run`, `npm test`, …) |
| Coverage | `vitest run --coverage` (`v8`), or `bun test --coverage --coverage-reporter=lcov` (lines and functions only) |
| Fix | `biome check --write PATHS`, or `eslint --fix PATHS` and `prettier --write PATHS` for the gap |

- After an edit that spans files or changes an exported signature, run the type
  check once before handing back, even when no other check is due: the project's
  `typecheck` script (`npm run typecheck`, `bun run typecheck`) when it has one,
  else `tsc --noEmit -p .`, or `tsc -b` for project references.
- Run tools through the project's package manager (`bunx`, `pnpm exec`, `npx`,
  `yarn`), and never let it download a tool the project does not already have.
- `tsc --noEmit` on a root `tsconfig.json` with `"files": []` and `references`
  checks nothing and passes; use `tsc -b` there. `tsc -b` builds referenced projects
  in dependency order and skips up-to-date ones; `tsc -b --verbose` says why each one
  rebuilt, and `tsc -b --clean` removes their outputs.
- Strict by default: `strict` is on by default since TypeScript 6.0. Do not loosen
  compiler options to make a check pass; the flags worth adding are in
  `lang-typescript-types`.
- TypeScript 7's native compiler has no stable programmatic API. Validate framework
  checkers and embedded-language tooling before migration; keep their TypeScript 6
  compatibility path when needed. Run the framework-aware checker, not only `tsc`.
- Run configured `Knip` for unused files, exports and dependencies. `unimported` is
  deprecated; `ts-prune`, `ts-unused-exports` and `depcheck` are stale.
- Complexity: Biome's `noExcessiveCognitiveComplexity` set to error with
  `maxAllowedComplexity` 15 (its default severity is information, so it never fails
  until you raise it). Do not add a second complexity gate.
- Dependency audit: `bun audit` or `npm audit` on every PR and on a schedule; review
  before `bun audit fix`. Use `osv-scanner` for several ecosystems.
- Mutation: `stryker run --mutate <changed files>` with incremental mode on pull
  requests, the full run on a schedule (`lang-typescript-testing` has the Bun runner and
  its limits).
- Public API breaks (published libraries): `api-extractor run` against the committed
  `.api.md` report, plus `attw --pack .` and `publint` on every PR. API Extractor,
  TypeDoc, typescript-eslint and the Bun Stryker runner need the TypeScript 6 API: keep
  a `@typescript/typescript6` alias (or `typescript@^6`) beside TypeScript 7.
- Docs: `typedoc` with warnings as errors; API Documenter when the API report is the contract.
- Install policy: detect a tool with the first command in its row of the libraries
  `testing.md` or `quality.md`, recommend the install command, and ask the user before
  you add a dependency or change a lockfile. Use the latest release; the rows give a
  minimum, not a pin. When a tool is missing and not approved, report that step as not run.
- A test runner that finds no tests did not test anything; report it, do not call it
  a pass.
- Fix mode on `.` rewrites files outside the task. Pass the touched paths, review the
  diff, and revert incidental rewrites.

## Workspaces

Narrow to the package the task touched, then run the whole workspace before handing
off a change to shared code:

```sh
bun run --filter '@shop/api' test          # bun; also --filter './packages/api'
pnpm --filter @shop/api test               # pnpm; --filter '@shop/api...' adds its dependencies
pnpm --filter '...[origin/main]' test      # pnpm: packages changed since origin/main and their dependents
npm test --workspace packages/api          # npm
tsc -b packages/api                        # type-checks api and the projects it references
```

## CI

Same steps, same order, one step per row. Set up the runtime with `oven-sh/setup-bun`
or `actions/setup-node` (`cache:` set to the package manager), install with the
frozen-lockfile command, then run each check. Workflow structure, the required
`ci-gate` job and action pinning are the `toolchain` plugin's `ci-github-actions`
skill.

In OpenCode, the built-in `biome`, `prettier` or `oxfmt` formatter rewrites each
file after the `edit`, `write` or `patch` tool changes it when `"formatter": true`
is set in `opencode.json` and the project configures that formatter. Keep the format
check for files changed any other way.

A missing `package.json`, `tsconfig.json` or tool means that step did not run.
Report it as not run, never as a pass. Read failures as the project's actual
toolchain output; do not invent extra linters.
