# Engineering

This page records the stack, layout and standards for `srobroek/opencode-plugins`. [AGENTS.md](../AGENTS.md) holds the agent rules and the command list. This page links to it instead of repeating it.

## Stack

The repository is a bun workspace of OpenCode V2 plugins written in TypeScript. Each plugin default-exports `Plugin.define({ id, setup })` from `@opencode/plugin`. No plugin uses the V1 API (`@opencode-ai/plugin`).

| Tool | Version | Source |
| --- | --- | --- |
| bun | 1.4.4 | `.mise.toml`, `bun-version` in `.github/workflows/ci.yml` |
| TypeScript | 7.0.2 | `package.json` |
| Biome | 2.6.8 | `package.json`; linter only, the formatter is off (`biome.json`) |
| `@opencode/plugin`, `client`, `theme` | 2.3.2 | `package.json` |
| `@opentui/core`, `@opentui/solid` | 0.9.3 | `package.json` |
| `solid-js` | 1.9.19 | `package.json` |
| `effect` | 4.1.4 | `package.json` |
| `smol-toml` | 1.9.1 | `plugins/lib`, `dep-update` and `safety` read TOML with it |
| `jsonc-parser` | 3.3.1 | `plugins/model-roles` edits JSONC config files with it |

`smol-toml` is a runtime `dependency` of `plugins/lib` and a `devDependency` of `dep-update` and `safety`. `jsonc-parser` is a runtime `dependency` of `model-roles`. The bundler inlines every imported module that is not a host module, so both ship in the bundle either way (see `scripts/build.ts`).

The build leaves these modules external (`HOST_MODULES` in `scripts/build.ts`): `@opencode/plugin`, `effect`, `@opentui/*` and `solid-js`, with their subpaths. OpenCode supplies them at runtime. `@opencode/client` and `@opencode/theme` are not on that list. AGENTS.md has the pinning rule for the `@opentui/*` and `solid-js` host modules.

The TypeScript config is strict. It adds `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `moduleResolution: bundler`. Tests run under `bun test` with the preload `scripts/test-preload.ts` (see `bunfig.toml`).

Known drift: `.mise.toml` pins `npm:@biomejs/biome` 2.5.15 while `package.json` pins 2.6.8. `bun run lint` uses the `package.json` version.

## Layout

```
plugins/<name>/     one plugin per directory, a workspace package
plugins/lib/        @srobroek/opencode-lib, shared helpers, internal
scripts/            build, generators and repository checks
docs/               design notes, decisions and this file
examples/           example projects included in typecheck
```

A plugin has `src/`, a committed `dist/`, an `index.js` shim and often `skills/`, `agents/` or `agents.src/`.

## Dependency direction

Intended rules:

- Plugins depend on `plugins/lib` as a `workspace:*` dev dependency. The build inlines `lib` into each plugin's bundle, because OpenCode installs a plugin from its own directory. So `lib` exists at build time only.
- Runtime `dependencies` must be on npm, because workspace packages do not exist at runtime.
- `plugins/lib` imports no plugin.
- `scripts/` may import from `plugins/lib/src` and read every plugin's `package.json`.
- Shared code goes into `lib`.

Current exceptions, found by searching relative imports under `plugins/*/src`:

- Source: `plugin-audit` imports `../../dep-update/src/bump.ts`, and `speckit` imports `../../beads/src/bd-embedded-write-lock.ts`. The build bundles these files into the importing plugin.
- Tests import another plugin's source. Examples: `agent-reviewer` tests import `delivery` and `quality`, and `cad`, `design` and `speckit` tests import `beads/src/subagent-routing.ts`.
- `scripts/` imports `plugins/agent-efficiency/src/lean.ts` in one test, and `design/src/formulas.test.ts` imports `scripts/check-steering.ts`.

Move new shared code into `lib` instead of adding another edge.

`plugins/lib/src/session-lanes.ts` holds the lane session helpers (`laneSessions`, `moveSessionsHome`, `isSessionNotFound`) that `subagent-worktree` and `delivery` use.

`plugins/delivery/src/clone-registry.ts` is the clone registry: the record of which other repositories a session landed in, so the turn-end retry and gc find those receipts after a restart.

- Ownership: `delivery` owns it. `pending-cleanup.ts` registers a clone when a landing's cleanup does not finish, retries from it at each turn end, and drops entries once a receipt is cleaned or superseded. Claims, holds, denials and landing records stay in the target repository's git common directory.
- Storage: one file per session, `<receipts root>/.clones/<sessionKey>.json`, holding `{ version: 1, clones: [{ commonDir, root, key, repo, receiptIds, addedAt }] }`. Receipts stay filed under the target's key. Every write is a read-modify-write under the same on-disk lease as the other coordination writes, and a registry left with no clones is deleted.
- Failure contract: reads are strict. A missing file is empty, and an unreadable one is reported and never treated as empty or overwritten (`updateRegistry` throws). Entries are dropped on positive evidence only. A failed registry write never stops cleanup: it is logged through `console.error` (`delivery: clone registry gc failed` or `update failed`), the entry stays, and the next turn end or gc retries it.

## Standards

[AGENTS.md](../AGENTS.md) Conventions covers bundles, generated files, vendored `plugins/cad` files, agents, skills, pitfalls and descriptions. Checks enforce most of it. This page adds:

- Renovate (`.github/renovate.json5`) updates dependencies. Version pins in skills and docs use the shapes its custom managers match.
- Approved departures: none recorded. Record each departure here with its reason.

## Commands

[AGENTS.md Commands](../AGENTS.md#commands) lists every script and the stages `bun run check` runs. The `cad:*` scripts need network and stay out of it.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- `check` runs `bun install --frozen-lockfile` and a `bun.lock` freshness check. It then runs typecheck, lint, test, `build:check`, `marketplaces:check`, `plugin-table:check`, `concerns` and `test-executables`. It does not run `steering`, `pitfalls`, `agent-roles` or `descriptions`.
- `claude-plugins` runs `claude plugin validate --strict` on the marketplace and each exported plugin.
- `cad` runs `cad:check` and the formula tests when `plugins/cad` changes.

Releases use release-please (`release-please-config.json`, `.release-please-manifest.json`). [AGENTS.md Conventions](../AGENTS.md#conventions) says what a new plugin needs.
