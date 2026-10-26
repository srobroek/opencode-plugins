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
- `bun run check` runs all three before you hand work off.

## Conventions

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
