---
name: toolchain-stack-defaults
description: Use when choosing or changing a project stack, package manager, or task runner, or when adding a dependency.
---

# Toolchain Stack Defaults

Keep existing project choices unless the current task is explicitly about setup,
migration, or standardization.

New projects: bun over npm/yarn, uv over pip/poetry, mise over nvm/pyenv, just
over make. In a tree already configured for the modern tool, do not reach for
the legacy one.

Dependencies: add, remove, and upgrade them through the package manager's CLI
(`bun add`, `uv add`, `cargo add`, `go get`), not by hand-editing the
manifest's dependency tables.

Treat `just`, `mise`, and `moon` as independent setup choices:

- `just` for task aliases and repeatable local workflows.
- `mise` for language and tool version management.
- `moon` for task orchestration in larger monorepos.

Language plugins, when installed, add skills that run the project's own format,
lint, and test tools. Language design guidance lives in the
`quality-code-design` skill.
