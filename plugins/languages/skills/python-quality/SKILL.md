---
name: python-quality
description: Use to run Python format, lint, type-check, and test commands with the project toolchain.
---

# Python Quality

Run the checks through the shell tool from the project root (the directory with
`pyproject.toml`). Prefer the project's runner: prefix each command with `uv run`
when the project has `uv.lock`, or `poetry run` with `poetry.lock`.

| Step | Command |
| --- | --- |
| Lint | `ruff check .` |
| Format check | `ruff format --check .` |
| Type check | `pyright` when the project configures it (or `mypy` if that is what it uses) |
| Test | `pytest` when `pyproject.toml` or `tests/` exists |
| Fix | `ruff check --fix .`, then `ruff format .` |

Fix mode on `.` can rewrite files outside the task. Review the diff and revert
incidental rewrites; for a narrow fix, pass the paths instead of `.`
(`ruff check --fix PATHS`, `ruff format PATHS`).

A pytest run that collects no tests (exit code 5) did not test anything; say so
rather than reporting a pass.

In OpenCode, the built-in `ruff` (or `uv`) formatter rewrites each `.py` file after
the `edit`, `write` or `patch` tool changes it when `"formatter": true` is set in
`opencode.json`. Keep `ruff format --check` in the check for files changed any
other way.

A missing project file or tool means that step did not run. Report it as not run,
never as a pass. Read failures as the project's actual toolchain output; do not
invent extra linters.
