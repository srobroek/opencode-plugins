# whats-new

Researches what changed between the version of a dependency, tool or service a
project uses and the latest one: breaking changes, deprecations, new features and
notable fixes. It reports and changes nothing.

Ported from the omp-plugins `whats-new` plugin.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/whats-new'
```

Claude Code and Codex install the skills from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install whats-new@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add whats-new@srobroek-opencode
```

Claude Code and Codex get the skill only. The `version_gap_scan` tool and the report-only `whats-new` agent are OpenCode code: there, name the target yourself (the skill has no dependency scanner) and nothing enforces report-only.

## Agent

The plugin adds a `whats-new` agent (mode `all`, so you can switch to it or launch
it as a subagent). Report-only mode is this agent's permissions. They are added
after any rules you configure for an agent with the same id:

- `edit` is denied for dependency manifests and lockfiles at any depth:
  `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
  `bun.lockb`, `*.lock`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`,
  `Pipfile`, `go.mod`, `go.sum`, `Gemfile` and `composer.json`.
- `shell` is denied for the install and upgrade commands of npm, pnpm, bun, yarn,
  pip, uv, poetry, cargo, go, bundler, gem and composer, for example `npm install *`,
  `uv sync *` and `go get *`.
- `dep_apply` is denied.

Static rules match whole commands, so the plugin also registers a
`permission.hook("evaluate")` for this agent only. It denies installers behind
wrappers (`sudo`, `env`, `timeout`, `npx`, `pnpm dlx`), inside `bash -c` or
`$( … )`, and manifest paths in any letter case. The policy reads commands
statically: it does not see writes made through `eval` or a script, and it is not a
sandbox.

Other agents are unaffected. To apply an upgrade, use the dep-update plugin from
another agent.

## Tools

`version_gap_scan` lists a project's root dependencies, offline and read-only. It
prints one tab-separated row per dependency: ecosystem, name, declared spec,
resolved lockfile version (`?` when unlocked), and `direct` or `transitive`.

The scanner reads the root language manifests, plus `package-lock.json`, `uv.lock`
and `poetry.lock` for resolved versions. It does not read other Node lockfiles,
`Cargo.lock`, `go.sum`, `Pipfile.lock`, Ruby or PHP lockfiles, or workspace child
manifests. When it reports a declaration range, resolve the installed version
separately.

## Skill

The plugin registers the `whats-new` skill from `skills/whats-new/SKILL.md`, unless a
skill with that id already exists. The skill links to recipes for registry, git and
service-feed endpoints, and to a report template.
