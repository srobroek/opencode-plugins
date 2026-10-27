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
| Lint and format check | One tool, the first found: project-local Biome (`biome check .`, lint and format), else ESLint (`eslint .`) plus Prettier (`prettier --check .`) when configured |
| Type check | `tsc -b` when `tsconfig.json` has `references`, otherwise `tsc --noEmit` |
| Test | The project's test script (`bun test`, `vitest run`, `npm test`, …) |
| Fix | `biome check --write PATHS`, or `eslint --fix PATHS` and `prettier --write PATHS` |

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
