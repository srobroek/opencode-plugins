# dep-update

Classifies a project's dependency declarations by semver safety and applies patch
or minor bumps one at a time, each behind a permission prompt. It applies bumps for
PyPI and npm; for Rust and Go it only advises.

Ported from the omp-plugins `dep-update` plugin.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/dep-update'
```

## Tools

| Tool | What it does |
| --- | --- |
| `dep_scan` | Reads root manifests and lockfiles, queries PyPI and npm, and classifies each exact-version bump as `PATCH-SAFE`, `MINOR-CHECK` or `MAJOR-ADVISORY`. Read-only. |
| `dep_apply` | Applies one bump through the project's package manager, then checks that the pin reached the manifest. |

`dep_scan` honours cancellation and stops after 5 minutes in total. A stopped scan
returns `complete: false` and marks every dependency it did not query `UNCHECKED`.

## Confirming a bump

`dep_apply` asks permission for action `dep_apply` with the resource
`<name>@<version>`, so the prompt names the exact bump. OpenCode's default policy
allows every action, so the plugin also registers a `permission.hook("evaluate")`
that turns an allowed `dep_apply` into `ask`. Every bump prompts, including one
covered by an earlier "allow always".

- To block bumps, add a deny rule. Deny rules always win:
  `{ "action": "dep_apply", "resource": "*", "effect": "deny" }`.
- To skip the prompt, set the plugin option `confirm` to `false`. Your
  permission rules then decide on their own.

A rejection with feedback, or a deny rule, comes back to the model as a tool error.
A plain rejection ends the step. The package manager stops after 10 minutes, after
64 KiB of output, or on cancellation. A stopped or failed run can leave partial
changes.

Python projects use `poetry add` when there is a `poetry.lock` or `[tool.poetry]`,
and `uv add` otherwise (`--frozen` when there is no `uv.lock`). A project with only
`requirements.txt` gets a manual instruction, and no install runs. Node projects pick
the package manager from `DEP_UPDATE_PKG_MANAGER`, or from the lockfile.

## Scanner-install advisory

After a `shell` call that installs a CVE scanner persistently (`pip-audit`,
`osv-scanner`, `cargo-audit`, `govulncheck` via `pip install`, `pipx install`,
`uv tool install`, `brew install`, a global npm/pnpm/bun/yarn install, `cargo install`
or `go install`), the plugin adds a note to the tool result. The note says the audit
changed the toolchain and lists the ephemeral runners to use instead. It does not
stop the command.

## Skill

The plugin registers the `dep-update` skill from `skills/dep-update/SKILL.md`, unless
a skill with that id already exists. The skill covers the scan, CVE scanners,
changelog citations and the one-bump-at-a-time apply loop.

## Coverage

The detector reads the root `package.json` (and `package-lock.json` for resolved
versions), `pyproject.toml` or `requirements.txt` (and `uv.lock` or `poetry.lock`),
`Cargo.toml`, `go.mod`, `Gemfile` and `composer.json`. It does not read
`Cargo.lock`, `go.sum`, `Pipfile.lock`, Ruby or PHP lockfiles, other Node lockfiles,
or workspace child manifests.

Classification needs exact versions. Ranges and wildcards are `UNRESOLVABLE` and are
never offered as upgrades. A prerelease is offered only when the installed version
is itself a prerelease.
