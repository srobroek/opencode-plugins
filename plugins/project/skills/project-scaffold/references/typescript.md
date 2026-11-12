# TypeScript

Load `lang-typescript` (router) for quality, testing, packaging, types and profiling
detail, and `toolchain-frontend` for the framework pick.

## Apps and monorepos: use Better-T-Stack

For any web, full-stack, native or backend TypeScript app or monorepo, scaffold with
create-better-t-stack (https://www.better-t-stack.dev/docs/cli), not by hand. Libraries,
single-purpose CLIs and scripts do not need it: `bun init` is enough.

1. Check the live contract instead of trusting this file: `bun create better-t-stack@latest schema --name createInput`
   (or `bunx create-better-t-stack@latest ...`), and `--help`.
2. Choose options with the user, one question each, recommended first. The CLI flags:
   `--frontend` (`tanstack-router`, `react-router`, `tanstack-start`, `next`, `nuxt`,
   `svelte`, `solid`, `astro`, native variants, `none`), `--backend` (`hono`, `express`,
   `fastify`, `elysia`, `convex`, `self`, `none`), `--runtime` (`bun`, `node`, `workers`),
   `--api` (`trpc`, `orpc`, `none`), `--database` (`sqlite`, `postgres`, `mysql`,
   `mongodb`, `none`), `--orm` (`drizzle`, `prisma`, `mongoose`, `none`), `--db-setup`,
   `--auth` (`better-auth`, `clerk`, `none`), `--payments`, `--addons` (`biome`, `oxlint`,
   `turborepo`, `nx`, `lefthook`, `husky`, `tauri`, `pwa`, `starlight`, `fumadocs`, `mcp`,
   `skills`, ...), `--examples`, `--web-deploy`, `--server-deploy`, `--package-manager`.
   Defaults to propose: `--package-manager bun`, `--runtime bun`, addon `biome` (the
   preferred linter/formatter), `--git`. Framework preference by surface is in
   `toolchain-frontend` (React + Vite for SPAs, Next.js for SSR, Astro for content); map it
   to the closest option and say when Better-T-Stack lacks it (for example React + Vite).
   Ask about the rest; do not guess auth, payments, database or deploy target.
3. Dry run first, show the result, then create:

   ```sh
   bun create better-t-stack@latest my-app --frontend tanstack-router --backend hono \
     --runtime bun --api orpc --database postgres --orm drizzle --auth better-auth \
     --addons biome --package-manager bun --no-install --disable-analytics --dry-run
   ```

   Re-run without `--dry-run`, then `bun install` separately. `create-json` takes the same
   fields as one JSON object when flag quoting gets awkward. Use `--directory-conflict error`
   in an existing directory. Later additions: `create-better-t-stack add --addons ...` or
   `add --package <name>`. It writes `bts.jsonc` with the reproducible command; commit it.
4. Never pass `--yolo`. `--db-setup` providers can create cloud resources: keep `manual`
   unless the user opts in.
5. Afterwards layer the common steps (mise pin for `bun`/`node`, `justfile`, docs,
   `AGENTS.md`, hooks) on top. Better-T-Stack already writes a git repo unless `--no-git`.

## Plain TypeScript (library, CLI, script)

```sh
mise use bun@latest
bun init                      # then `bun add -d typescript @types/bun @biomejs/biome`
```

## Preferred tools and libraries

| Need | Pick |
| --- | --- |
| Package manager | `bun` (pnpm only for existing pnpm monorepos); `bun add`/`bun remove` |
| Lint + format | `Biome` 2 (`biome check`) is the default; `ESLint` 10 flat config plus `Prettier` when required plugins need it. `Oxlint` 1 with `oxlint-tsgolint` is an optional type-aware alternative; avoid overlapping mandatory lint. `Knip` 6 (`bunx knip`) for unused files, exports and dependencies, in the gate |
| Types | `tsc --noEmit` (`tsc -b` with project references), `strict` plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (`lang-typescript-types`) |
| Tests | Vitest (`vitest run`) per `toolchain-languages`, unless the project already uses `bun test`; the old scaffold used `bun test` with `bun test --coverage`. Keep one runner. `msw` for HTTP mocks |
| Validation | Zod at runtime boundaries; OpenAPI for HTTP contracts |
| Server state / UI | TanStack Query for server state; shadcn/ui and Base UI with React (`toolchain-frontend`) |

CLI framework, HTTP framework outside Better-T-Stack, and logging: ask the user.

TypeScript 7 has a native compiler but no stable programmatic API. Validate framework
checkers and embedded-language tools before migrating; retain their TypeScript 6
compatibility path when needed, not just a passing `tsc` run.

## Gate (`just check`)

`bun install --frozen-lockfile`, `biome check .`, `tsc --noEmit` (or `tsc -b`), the test
script and configured `knip` task. Use the selected lint stack, not all alternatives.
CI: `oven-sh/setup-bun`, same steps. Commit `bun.lock`. `.gitignore`: `node_modules/`,
`dist/`, `.env*` (keep `.env.example`).
