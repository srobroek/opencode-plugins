# Optional capabilities

Offer, never impose. Ask whether the project has the surface at all; skip silently when
it does not. Each capability adds a pinned tool in `mise.toml`, a `justfile` task that
`just check` includes, and a CI job. Pin versions at current stable and tell the user.

## HTTP API contract (OpenAPI)

Ask: does the service expose an HTTP API others consume? Server URL (unknown is normal;
use a visible placeholder), contract version (starts `0.1.0`, version of the contract, not of
OpenAPI), organization for the contact.

- File `openapi.yaml` at the root, `openapi: 3.1.0`, with `info` (title, version,
  description, contact name and repo URL, license when published), `servers`, a `health` tag
  and a worked `/health` `getHealth` example so the gate is green before the first endpoint.
- Tools: `vacuum` and `oasdiff` (mise: `vacuum`, `"ubi:oasdiff/oasdiff"`).
- Tasks: `vacuum lint --fail-severity warn openapi.yaml`; breaking-change check against the
  PR base: `git show origin/main:openapi.yaml > "$base"` then
  `oasdiff breaking --fail-on ERR "$base" openapi.yaml`, skipping when the base has no spec;
  `oasdiff changelog` to print the diff. Fetch full history in CI (`fetch-depth: 0`) and set
  the baseline ref to the PR base branch.
- With Better-T-Stack and `--api orpc`, OpenAPI comes from the framework; still keep
  `openapi.yaml` as the committed contract if consumers depend on it (`toolchain-languages`:
  OpenAPI for HTTP contracts).

## i18n (Inlang / Paraglide)

Ask: which locales ship? Base locale (default `en`)? Where does the Inlang project live
(`project.inlang` at the root, or `apps/web/project.inlang` in a monorepo)?

- `project.inlang/settings.json`: `baseLocale`, `locales` (must include the base), `modules`
  with the Inlang message-format plugin module URL (pin its version; the old default was
  `https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js`), and
  `"plugin.inlang.messageFormat": { "pathPattern": "./messages/{locale}.json" }`.
- Catalogs in `messages/<locale>.json` next to the project directory, starting with
  `{ "$schema": "https://inlang.com/schema/inlang-message-format", "hello_world": "Hello, world" }`.
- A catalog parity check (node script run by `just i18n`) fails when a shipped locale lacks
  its catalog or keys the base has. Node pinned in mise for it.
- Only the base catalog is written at setup; each other locale fails the check until its
  catalog exists, which is intended.

## Accessibility (axe on named routes)

Ask: which surfaces (name, base URL) and routes should be scanned, and which command starts
the dev server and its URL? With no routes yet, record scanning as a gap rather than faking a
route.

- Isolated `.a11y/` package: `package.json` with `@axe-core/playwright` and
  `@playwright/test`, `playwright.a11y.config.ts` (`testDir ./tests`, `testMatch **/*.pw.ts`,
  `webServer` from `web-servers.json`, `reuseExistingServer: !process.env.CI`), a test that
  visits every surface route and asserts `new AxeBuilder({ page }).analyze()` has no
  violations, `surfaces.json` `[{name, baseURL, routes}]`, `web-servers.json`
  `[{command, url, cwd}]`.
- Tasks: install deps with `cd .a11y && bun install --frozen-lockfile`; browser with
  `bunx playwright install chromium` (add `--with-deps` on Linux and CI); run
  `cd .a11y && bunx playwright test --config playwright.config.ts --pass-with-no-tests`
  (use the config file name you actually created). Bun pinned in mise.
- Keep `.a11y/node_modules/` ignored, and exclude its JSON data files from the formatter.

## Infrastructure: AWS CDK (TypeScript)

Ask first whether Terraform or OpenTofu is the baseline (`toolchain-infrastructure`); CDK
only when application code and AWS constructs are tightly coupled. If chosen:

- Destination `infrastructure/` (repo-relative, ask if different). Generate with the
  CDK's own init, pinned to an exact stable `aws-cdk` version: `bunx aws-cdk@<x.y.z> init app
  --language typescript` in an empty scratch directory, then move the result in and drop what
  an npm-package template adds that this repo does not need (its own git repo, duplicate
  lockfiles). Do not template CDK code by hand.
- Tasks: install (`cd infrastructure && bun install --frozen-lockfile`), `synth`
  (`bun run cdk synth`); the gate is synth only.
- Never bootstrap or deploy unless the user asks in this conversation. Credentials for it
  come from `project-secrets` (AWS section), not from files.
- Keep CDK's tests out of the root TypeScript config (exclude `infrastructure/` in the root
  `tsconfig.json` and Biome includes).
