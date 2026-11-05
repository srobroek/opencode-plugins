---
name: project-scaffold
description: "Use for a new project, scaffold, bootstrap or init repo: ask, set up the language, docs, OpenCode config, plugins."
---

# Project scaffold

Instructions, not a script. Interview the user, then set the project up with each
language's own tools. Never copy template trees by hand. Keep what the user already
has in an existing repository unless they ask to change it.

Preferences live in other skills; load them by id instead of restating them here:
`toolchain-guide` (routes to `toolchain-stack-defaults`, `toolchain-languages`,
`toolchain-frontend`, `toolchain-infrastructure`, `toolchain-quality-observability`,
`ci-github-actions`, `ops-toolchain-cache-policy`, `ops-no-global-cargo-target`,
`shell-language`), `architecture-guide`, `quality-code-design`, `license-picker`.
Where neither this skill nor those say what to use, ask the user. Do not invent a pick.

## 1. Interview

Ask in rounds, with structured questions when the host offers them (`parley` or the
question tool), recommended answer first. Skip what the argument or the repository
already answers. Check the target first: `git rev-parse --is-inside-work-tree` and
`git ls-files | head` tell greenfield from existing; an existing repository follows
`references/brownfield.md`.

1. Shape: purpose in one sentence and the project name; app, library, CLI, service, worker
   or desktop app; language(s); one package or a monorepo. Offer the closest suggested
   shape from `references/shapes.md` (minimal, py-lib, rust-cli, go-service, ts-service,
   api-service, gitlab-service, polyglot-service, desktop-rust-ts, monorepo, web-app,
   fullstack-web) and customise from there.
2. Governance and forge (`references/governance.md`): CODEOWNERS owner, security contact,
   conduct contact (omit the file without one), license, public or private, GitHub or
   GitLab, self-hosted hostname, default branch `main`.
3. Capabilities (`references/capabilities.md`), only those that apply: HTTP API contract,
   i18n locales, accessibility-scanned routes, infrastructure (AWS CDK).
4. Delivery: CI and hook options and release flow (`references/ci-hooks.md`; none,
   release-please, or semantic-release per `trunk-dev-release-setup`), Renovate or Dependabot.
5. Workflow: beads, speckit, journeys, parallel agents with worktrees
   (`references/worktrees.md`), secrets needed?
6. Defaults gate: take current pins and defaults (job timeout 15 min, large-file limit
   512 KB, README install `mise install && just setup`, dev command `just dev`) or customise.
   Ask once; do not interrogate each value.

Read the plan back (name, shape, languages, layout, tools and pinned versions, capabilities,
files you will create) and wait for approval before writing anything. Where an answer is
unknown and not essential, leave a visible placeholder (for example `@TODO-owner`) and list it
in the final report instead of inventing a value.

## 2. Create the repository

1. Directory and `git init -b main`. Add a `.gitignore` for the languages (the
   language's own init usually writes one; extend it, do not replace it).
2. Pin tools with mise: `mise use <tool>@<version>` writes `mise.toml`. Ask the user
   for versions or take current stable and say which. mise pins runtimes and CLI
   tools; the language's own file pins the rest (`rust-toolchain.toml`, `go.mod`,
   `requires-python`, `package.json` `packageManager`).
3. Add a `justfile` with the quality gate as one `just check` recipe (the commands
   from the language reference) and `just fmt` / `just test`. Task runner choice is
   `toolchain-stack-defaults`; a larger monorepo may want `moon` (ask).
4. Run the language setup from `references/<lang>.md`: `rust.md`, `python.md`,
   `go.md`, `typescript.md`. Several languages or packages: `references/monorepo.md`.
5. Add the license through `license-picker`, then a short `README.md` (what, install,
   usage, how to run `just check`).
6. Secrets: decide project secrets handling and load the `project-secrets` skill
   (fnox.toml with 1Password vault refs, local sync cache, GitHub Actions push
   targets, AWS leases). Skip it when the project has no secrets.

## 3. Docs and agent instructions

Tree and file contents: `references/layout.md`. Follow `architecture-docs-files`. The global OpenCode config loads `CONTRIBUTING.md`,
`docs/architecture.md`, `docs/stack.md` and `docs/engineering.md` as instructions when
present, so write the smallest useful version of each:

- `docs/stack.md`: languages, package manager, frameworks, quality tools, as decided.
- `docs/architecture.md`: system shape and boundaries; top-level layout from
  `architecture-top-level`. A one-paragraph stub is fine early.
- `docs/engineering.md`: how to run, test, release; commit and branch rules
  (Conventional Commits, trunk-based; `trunk-dev-guide`).
- `docs/operations.md` and `docs/product.md` only when there is something to say.
- `CONTRIBUTING.md` only for a project others contribute to.
- `AGENTS.md` at the root: commands to build, test and check, layout pointers to
  `docs/`, project rules. Keep it short and link to `docs/` instead of copying.
  OpenCode V2 reads `AGENTS.md` only, not `CLAUDE.md`.

## 4. OpenCode project config

Docs: https://opencode.ai/v2/docs/config/. Project config is `opencode.jsonc` in the
root or `.opencode/opencode.jsonc`; pick one form. It merges over the global
`~/.config/opencode/opencode.json`, so read the global file first and add only what
the project needs:

- `plugins`: the project-specific plugins from step 6 (arrays merge with the global list).
- `formatter`: only when the global config has not enabled it, or to override one
  built-in for this project (biome over prettier is the preference).
- `instructions`: only extra files the global list does not already load.
- `permissions`: allow the project's check commands (`just check`, `cargo clippy *`)
  when the user wants fewer prompts.
- `mcp`, `references`, `skills`: only on request.
- Project skills go under `.opencode/skills/<id>/SKILL.md`; project commands under
  `.opencode/commands/<name>.md`.

Never put secrets in the file; use `{env:NAME}` or the `project-secrets` skill.

## 5. Tracking and workflow (if chosen)

- Beads: load `beads-setup` (it needs a git `origin` first; use `bd init --skip-hooks`
  on the work laptop, see the steering file linked from the global AGENTS.md).
- SpecKit: `speckit-setup` (needs `bd`). Journeys: `journey-init`.
- Release: `trunk-dev-release-setup`; release-please is the GitHub alternative.
- CI on GitHub: `ci-github-actions` (one `ci-gate` job, pinned actions, least
  permissions) plus the language's CI notes in its plugin skills.
- Worktrees: `references/worktrees.md` (the `worktrunk` plugin). For Rust, never set a global `CARGO_TARGET_DIR`
  (`ops-no-global-cargo-target`); caches follow `ops-toolchain-cache-policy`.
- Hooks, CI jobs, release-please and Renovate defaults to offer: `references/ci-hooks.md`.
  Wire hooks into `just check` so CI and local agree.

## 6. Pick plugins

Load `references/plugins.md`: it explains how to list every plugin, which are
already global, and the install spec. Recommend by the project's languages and
workflow, show the shortlist with one line each, install only what the user accepts.

## 7. First commit and verify

1. Run the full gate (`just check`, or the language commands) and fix it until green.
   A tool that cannot run is "not run", never a pass.
2. Start OpenCode checks: the project config parses (`opencode.jsonc` valid JSONC),
   new skills show up, the added plugins load (`opencode plugin list`).
3. `git add` specific files, review `git status`, then commit once:
   `chore: scaffold <name>` (Conventional Commits). Do not push, create the remote
   repository, or add branch protection unless the user asked; offer it.
4. Report: what was created, versions chosen, commands to run, open decisions.

Checklist before reporting: git initialised; tools pinned; gate green; license set;
`README.md`, `AGENTS.md`, `docs/stack.md` written; `.gitignore` covers build output
and `.env`; no secrets committed; plugins and OpenCode config as agreed; one commit.
