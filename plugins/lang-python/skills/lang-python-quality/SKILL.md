---
name: lang-python-quality
description: Use to run Python uv lock --check, ruff, mypy or pyright, and pytest -x checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
---

# Python Quality

Sources: [uv CLI reference](https://docs.astral.sh/uv/reference/cli/) (uv 0.13), [uv workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/), [ruff](https://docs.astral.sh/ruff/), [mypy configuration](https://mypy.readthedocs.io/en/stable/config_file.html), [pyright configuration](https://microsoft.github.io/pyright/#/configuration), [pytest exit codes](https://docs.pytest.org/en/stable/reference/exit-codes.html).

Run the checks through the shell tool from the project root (the directory with
`pyproject.toml`), in this order. Stop at the first failing step, fix it, rerun that
step, then continue. Prefix each tool with the project's runner: `uv run` when the
project has `uv.lock`, `poetry run` with `poetry.lock`.

| Step | Command |
| --- | --- |
| Lockfile | `uv lock --check` (fails when `uv.lock` no longer matches `pyproject.toml`) |
| Lint | `uv run ruff check .` |
| Format check | `uv run ruff format --check .` |
| Type check | `uv run mypy` or `uv run pyright`, whichever the project configures |
| Test | `uv run pytest -x` |
| Fix | `uv run ruff check --fix PATHS`, then `uv run ruff format PATHS` |

- After an edit that spans modules or changes a signature, run the type check once
  before handing back: the project's own script or task when it has one, else
  `uv run pyright` or `uv run mypy`, whichever `pyproject.toml` (or
  `pyrightconfig.json`, `mypy.ini`) configures.
- `uv run` syncs the environment first and may rewrite `uv.lock`. In checks and CI
  use `uv run --locked …` (error instead of relocking); never commit a lockfile
  change the task did not ask for.
- Type checking is strict by default for code you write: `[tool.mypy] strict = true`
  or `[tool.pyright] typeCheckingMode = "strict"`. Use the mode the project
  configures; when it is laxer, keep new modules clean under strict and say so,
  rather than flipping the project setting.
- `pytest -x` stops at the first failure; rerun only the failures with
  `pytest --lf -x`. Narrow with `pytest tests/test_billing.py -k refund`.
- A pytest run that collects no tests (exit code 5) did not test anything; report
  it, do not call it a pass.
- Fix mode on `.` rewrites files outside the task. Pass the touched paths, review the
  diff, and revert incidental rewrites.

## Workspaces

In a uv workspace (`[tool.uv.workspace]` in the root `pyproject.toml`), one `uv.lock`
at the root covers every member. Run `uv lock --check` once at the root, then narrow
the rest to the member the task touched:

```sh
uv run --locked --exact --package billing python -m pytest -x packages/billing/tests
uv run --locked --exact --package billing python -m mypy packages/billing/src
```

`--package` runs in that member's context, and `--exact` first removes from the shared
`.venv` whatever the member does not declare. Without `--exact`, an import of a
sibling's dependency still passes because an earlier `uv sync --all-packages`
installed it. Two traps, checked with uv 0.13:

- With `--package`, only that member's own dependency groups are installed, not the
  root's `dev` group. When pytest or mypy live only in the root group, drop
  `--exact` for that run and say the member's dependencies were not isolated.
- Call tools as `python -m pytest`, not `pytest`: when the environment lacks the
  tool, a bare name silently runs a global binary from `PATH` instead of failing.

Run the whole workspace (`uv sync --locked --all-packages`, then each step from the
root) before handing off a change to shared code.

## CI

Same steps, same order, one step per row. Install uv with `astral-sh/setup-uv`
(`enable-cache: true`), then `uv sync --locked --all-packages` (add `--all-groups`
when the checks need dependency groups beyond `dev`) and `uv run --locked` each tool.
Workflow structure, the required `ci-gate` job and action pinning are the `toolchain`
plugin's `ci-github-actions` skill.

In OpenCode, the built-in `ruff` (or `uv`) formatter rewrites each `.py` file after
the `edit`, `write` or `patch` tool changes it when `"formatter": true` is set in
`opencode.json`. Keep `ruff format --check` for files changed any other way.

A missing project file or tool means that step did not run. Report it as not run,
never as a pass. Read failures as the project's actual toolchain output; do not
invent extra linters.
