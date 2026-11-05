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
| Types | `pyright` strict is the current preference (`toolchain-languages`, `lang-python-types`). The old bootstrapper used `ty`; no toolchain or `lang-python` skill recommends it, so use it only if the user asks |
| Tests | `pytest` (`--strict-markers --strict-config`, `filterwarnings = error`); `hypothesis` for properties |
| APIs | FastAPI with Pydantic; Litestar when the app needs stronger structure |
| Database | SQLAlchemy + Alembic (`lang-python-persistence`) |
| Import rules | `import-linter` (`lint-imports`) |
| Unused or missing deps | `deptry` (`uv run deptry .`) in the gate |
| Coverage | `pytest-cov` (`--cov --cov-report=term-missing --cov-report=lcov`); ask whether to enforce a threshold (`--cov-fail-under=N`); the old scaffold set none |
| Matrix | `nox` for several Python versions only if the library supports more than one; ask |

CLI framework, HTTP client, logging and settings libraries: ask the user (sources are
silent). Logging for services follows `toolchain-quality-observability`.

## Gate (`just check`)

`uv lock --check`, `uv run ruff check .`, `uv run ruff format --check .`,
`uv run pyright`, `uv run pytest -x`, `uv run deptry .`; add `uv run lint-imports` when contracts exist.
CI: `astral-sh/setup-uv` with `enable-cache: true`, `uv sync --locked`, `uv run --locked`.

## Rules

- Dependencies only through `uv add`/`uv remove`.
- `.gitignore`: `.venv/`, `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`, `dist/`.
