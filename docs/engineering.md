# Engineering

This is the stack, layout and standards for `srobroek/opencode-plugins`. Agent rules, such as the commit format and what to commit, live in [AGENTS.md](../AGENTS.md).

## Stack

The repository is a bun workspace of OpenCode V2 plugins written in TypeScript. Each plugin default-exports `Plugin.define({ id, setup })` from `@opencode/plugin`. The V1 API (`@opencode-ai/plugin`) is not used.

| Tool | Version | Source |
| --- | --- | --- |
| bun | 1.4.4 | `.mise.toml`, `bun-version` in `.github/workflows/ci.yml` |
| TypeScript | 7.0.2 | `package.json` |
| Biome | 2.6.8 | `package.json` (formatter and linter) |
| `@opencode/plugin`, `client`, `theme` | 2.3.2 | `package.json` |
| `@opentui/core`, `@opentui/solid` | 0.9.3 | `package.json` |
| `solid-js` | 1.9.19 | `package.json` |
| `effect` | 4.1.4 | `package.json` |

`@opencode/*`, `@opentui/*`, `solid-js` and `effect` are host modules (`HOST_MODULES` in `scripts/build.ts`). OpenCode supplies them at runtime, so the bundle leaves them external. The root `package.json` pins the `@opentui/*` and `solid-js` host modules to their latest release, never below the version in the OpenCode release's root catalog. Renovate's host-module rule disables them.

The TypeScript config is strict, with `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `moduleResolution: bundler`. Tests run under `bun test` with the preload `scripts/test-preload.ts` (see `bunfig.toml`).

Known drift: `.mise.toml` pins `npm:@biomejs/biome` 2.5.15 while `package.json` pins 2.6.8. `bun run lint` uses the `package.json` version.

## Layout and dependency direction

```
plugins/<name>/     one plugin per directory, a workspace package
plugins/lib/        @srobroek/opencode-lib, shared helpers, internal
scripts/            build, generators and repository checks
docs/               design notes, decisions and this file
examples/           example projects included in typecheck
```

- A plugin has `src/`, a committed `dist/`, an `index.js` shim and often `skills/`, `agents/` or `agents.src/`.
- Plugins depend on `plugins/lib` as a `workspace:*` dev dependency. `plugins/lib` is build-time only: the build inlines it into each plugin's bundle, because OpenCode installs a plugin from its own directory.
- `plugins/lib` depends on no plugin. Plugins do not import each other. Shared code goes into `lib`.
- `scripts/` may import from `plugins/lib/src` and read every plugin's `package.json`. No plugin imports from `scripts/`.
- Runtime `dependencies` must be published on npm, because workspace packages exist only at build time.
- Plugin ids are `srobroek.<name>`. Tool names are `<name>_<verb>`.

## Standards

The Conventions section of [AGENTS.md](../AGENTS.md) holds the rules for bundles, generated files, agents, skills, pitfalls and descriptions. The checks below enforce most of them. Beyond those:

- Decision logic lives in pure exported functions with direct tests. `setup` is a thin adapter over the plugin context and returns a cleanup function that disposes every registration.
- Generated files (`dist/`, shims, marketplaces, composed agents, the plugin table) are never hand-edited. Regenerate them and commit the output with the source change.
- `plugins/cad/{skills,examples,agents}` is vendored from a pinned cad-agent tag and never edited.
- Dependencies are updated by Renovate (`.github/renovate.json5`). Versions in skills and docs follow the shapes its custom managers match.

Approved departures: none recorded. Record a departure here with its reason.

## Commands

| Command | Purpose |
| --- | --- |
| `bun install` | Install the workspace |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome check |
| `bun test` | Run all tests |
| `bun run build` / `build:check` | Regenerate or verify `dist/` and shims |
| `bun run marketplaces` / `marketplaces:check` | Claude Code and Codex marketplaces |
| `bun run plugin-table` / `plugin-table:check` | Plugin table in the project-scaffold reference |
| `bun run steering`, `pitfalls`, `agent-roles`, `descriptions`, `concerns`, `test-executables` | Repository checks, described in AGENTS.md |
| `bun run cad:sync` / `cad:check` | Vendored cad-agent files, needs network |
| `bun run check` | Everything above except `cad:*` |

Tests that spawn processes or run git set a measured timeout, as AGENTS.md describes.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- `check`: `bun install --frozen-lockfile`, a `bun.lock` freshness check, then typecheck, lint, test, `build:check`, `marketplaces:check`, `plugin-table:check`, `concerns` and `test-executables`.
- `claude-plugins`: `claude plugin validate --strict` on the marketplace and each exported plugin.
- `cad`: runs `cad:check` when `plugins/cad` changes.

Releases use release-please (`release-please-config.json`, `.release-please-manifest.json`). A new plugin needs an entry in both files.
