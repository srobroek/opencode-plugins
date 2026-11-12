# Python

Load `lang-python` (router) for quality, testing, types, packaging and persistence detail.

## Init

```sh
mise use python@3.13 uv@latest      # ask for the Python minor
uv init --package <name>            # library/CLI with src layout; plain `uv init --app` for a script-style app
uv add <pkg>                        # runtime deps
uv add --dev pytest ruff pyright    # dev group (PEP 735)
```

`uv init` creates `pyproject.toml`, `.python-version` and a git repo unless one exists
(`--vcs none`). Set `requires-python`. Commit `uv.lock`. Several packages: a uv
workspace (`[tool.uv.workspace] members = ["packages/*"]`, `lang-python-packaging`).

## Preferred tools and libraries

| Need | Pick |
| --- | --- |
| Packages / venv | `uv` (not pip, poetry) |
| Lint + format | `ruff` (`ruff check`, `ruff format`); selected rules at least `E F I N W UP B SIM TC ANN RUF PERF C4 PT S`; per-file ignore `assert` and `ANN` in `tests/**` |
| Types | `pyright` strict is the preference; keep configured mypy (`lang-python-types`). `ty` is beta with no stable API: opt-in pilot, not the default gate |
| Tests | `pytest` (`--strict-markers --strict-config`, `filterwarnings = error`); `hypothesis` for properties |
| APIs | FastAPI with Pydantic; Litestar when the app needs stronger structure |
| Database | SQLAlchemy + Alembic (`lang-python-persistence`) |
| Import rules | `import-linter` (`lint-imports`) |
| Unused or missing deps | `deptry` (`uv run --locked deptry .`) in the gate |
| Dead code | Optional `Vulture` (`uv run --locked vulture . --min-confidence 100`); baseline reviewed dynamic-use exceptions. `Ruff` `F401`/`F841` cover imports/local variables, not whole-project reachability |
| Vulnerabilities | `pip-audit` or `OSV-Scanner` v2; `uv audit` only after validating the pinned version's preview policy |
| Coverage | `pytest-cov` (`--cov --cov-report=term-missing --cov-report=lcov`); ask whether to enforce a threshold (`--cov-fail-under=N`); the old scaffold set none |
| Matrix | `nox` for several Python versions only if the library supports more than one; ask |

CLI framework, HTTP client, logging and settings libraries: ask the user (sources are
silent). Logging for services follows `toolchain-quality-observability`.

## Gate (`just check`)

`uv lock --check`, `uv run --locked ruff check .`, `uv run --locked ruff format --check .`,
`uv run --locked pyright`, `uv run --locked pytest -x`, `uv run --locked deptry .`;
add `uv run --locked lint-imports` when contracts exist. Configure `Ruff` `S` rules for
security and optional `C901` with a 10-12 complexity limit and reviewed exceptions.
Add `Bandit` only for required checks not covered by configured `Ruff` `S` rules.
CI: `astral-sh/setup-uv` with `enable-cache: true`, `uv sync --locked`, `uv run --locked`.

## Rules

- Dependencies only through `uv add`/`uv remove`.
- `.gitignore`: `.venv/`, `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`, `dist/`.
