# project

Project lifecycle skills and one slash command: scaffolding a standard project and
picking a license.

| Skill | When |
| --- | --- |
| `project-secrets` | Secrets, API keys, `.env`, fnox, 1Password, CI secrets or AWS credentials for a project |
| `project-scaffold` | A new project, "scaffold", "bootstrap", "init repo"; also run by `/new-project` |
| `license-picker` | "What license should I use", a new repository without one, relicensing, or a quick question about license mechanics, per-file headers or CLAs |

## `/new-project`

`/new-project [language or project name]` submits a prompt that loads the
`project-scaffold` skill with your arguments. The plugin registers it with
`ctx.command.transform`; the prompt text is the pure function `scaffoldPrompt`.

`project-scaffold` is instructions, not a generator. It interviews you (purpose,
languages, single package or monorepo, app/library/CLI/service, license, hosting and CI,
release flow, beads, speckit, secrets), then sets the project up with each language's own
tools: `references/rust.md`, `python.md`, `go.md`, `typescript.md` (apps and monorepos
through Better-T-Stack), `monorepo.md`. The standard layout (`layout.md`: baseline tree,
`.editorconfig`, `.gitattributes`, per-type sketches), suggested shapes from the old presets
(`shapes.md`), the governance, forge and defaults round (`governance.md`), optional capabilities
(`capabilities.md`: OpenAPI, i18n, accessibility, AWS CDK), the `justfile` surface, CI, hook
and release options (`justfile.md`, `ci-hooks.md`), Worktrunk setup (`worktrees.md`) and
existing-repository handling (`brownfield.md`) each have their own reference. It points at the `toolchain-*`, `lang-*`,
`architecture-docs-files` and `trunk-dev-*` skills for preferences instead of copying
them, and asks where those are silent. It also covers mise pinning, a `just check` gate,
`docs/` and `AGENTS.md`, project `opencode.jsonc`, hooks, a first commit and a
verification checklist. `references/plugins.md` shows how to list every plugin in this
repository (`find_tools_scan`, the GitHub API, the marketplace file) and add the relevant
ones to the project. The secrets step loads `project-secrets`.

## `project-secrets`

Per-project secrets with [fnox](https://fnox.jdx.dev/) and 1Password. Guidance and the
questions to ask, not a script: a committed `fnox.toml` of references, vault placement
(Private, a shared `dev-shared` vault, or a `proj-<name>` vault only when access differs),
the gitignored `fnox.local.toml` sync cache, `fnox exec` and mise tasks to consume, and the
rules that keep values out of the transcript. It assumes the host's global fnox config
(providers `op` and `age`, shared machine keys) and does not redeclare it. References:
`fnox-config.md`, `ci-github.md` (service account or `fnox push`), `aws-leases.md` (Identity
Center, `aws-sts` and `command` leases for personal AWS accounts) and `mcp.md` (`fnox mcp`,
off by default). Commands were checked against fnox 1.47.

`license-picker` asks structured questions about the project, the threat model and
commercial goals, recommends an OSI-approved license from its decision matrix,
checks it against ecosystem norms, and offers to write the LICENSE file, manifest
field and headers. Its references live beside it in `references/`.

Ported from the omp-plugins `project` plugin; reference links are now relative
paths. The omp `project-managed-asset-promotion` rule is not ported: it governs
promoting machine-local omp skills and rules. This is the authoritative copy; the
earlier one under `~/.claude/skills` is gone.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/project'
```

Claude Code and Codex install the same skill from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install project@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add project@srobroek-opencode
```

A skill you already have with the same name wins over the plugin's copy.
