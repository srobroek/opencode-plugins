# AGENTS.md

Instructions for coding agents working in this repository.

## Repository

OpenCode V2 plugins. Each plugin lives in `plugins/<name>/` as a bun workspace
package whose entry point default-exports `Plugin.define({ id, setup })` from
`@opencode/plugin`. Do not use the V1 API (`@opencode-ai/plugin`).

## Commands

- `bun install`
- `bun run typecheck`
- `bun run lint`
- `bun test`
- `bun run build` regenerates every plugin's `dist/` and root `index.js` shim.
- `bun run build:check` fails when committed build output is stale.
- `bun run check` runs typecheck, lint, test and build:check before you hand
  work off.

## Conventions

- Plugins ship a committed bundle. `package.json` exports `"./dist/index.js"`
  (and `"./tui": "./dist/tui.js"` for a TUI entry, built from `src/tui.ts(x)`),
  sets `"files": ["dist", "index.js"]`, keeps `@opencode/plugin` an optional
  peer dependency, and lists `@srobroek/opencode-lib` as a `workspace:*` dev
  dependency. Never hand-edit `dist/` or the shims; run `bun run build` and
  commit the output with the source change. Do not add `prepare`/`prepack`
  scripts to plugin packages.
- Runtime `dependencies` must be published on npm. Workspace packages are only
  available at build time.
- Plugin ids: `srobroek.<name>`. Tool names: `<name>_<verb>`.
- Keep decision logic in pure exported functions and test them directly; keep
  `setup` a thin adapter over the plugin context.
- Return the cleanup function from `setup` and dispose every registration in it.
- Do not inject changing state into the system prompt on every request; it breaks
  provider prompt caching. Put live state in tool results.
- Conventional Commits. Scope is the plugin name, for example `feat(beads): ...`.
- A new plugin needs entries in `release-please-config.json` and
  `.release-please-manifest.json`.

## Issue tracking

This repository uses beads (`bd`). Run `bd prime` for the workflow.
