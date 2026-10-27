---
name: lang-python-packaging
description: Use for Python package layout (src layout, __init__ facades, __all__, import-linter, uv workspaces, dependency groups).
metadata:
  opencode/autoinvoke: false
---

# Python Packaging

Sources: [Python Packaging User Guide: src layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/), [PEP 735 dependency groups](https://peps.python.org/pep-0735/), [uv projects](https://docs.astral.sh/uv/concepts/projects/) and [workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/) (uv 0.13), [Import Linter](https://import-linter.readthedocs.io/), [PEP 561](https://peps.python.org/pep-0561/). Checked with uv 0.13.4 and import-linter on Python 3.13.

Module design (functions, protocols, exception hierarchies) is the `quality-code-design`
skill's `python.md` reference. This skill is the package mechanics.

## src layout

```text
pyproject.toml
src/shop/__init__.py      public API facade
src/shop/_pricing.py      private implementation modules start with _
src/shop/py.typed         empty marker: the package ships type hints (PEP 561)
tests/test_pricing.py
```

`uv init --package shop` (or `--lib`) creates this with the `uv_build` backend. With
code under `src/`, tests and scripts import the installed package, so a module missing
from the build or a forgotten data file fails in tests instead of after release.

## `__init__.py` as the facade

```python
"""Pricing and checkout."""
from shop._pricing import Price, quote
from shop._errors import PricingError

__all__ = ["Price", "PricingError", "quote"]
```

- `__init__.py` declares the public API: re-exports and `__all__`, nothing else. Logic
  there is logic that leaked out of the module owning it.
- `__all__` is the contract: type checkers treat the names in it as re-exported, and
  pyright reports `reportPrivateImportUsage` when a caller imports any other name from a
  `py.typed` package. It also bounds `from shop import *`.
- Keep it free of side effects and heavy imports: every `import shop.anything` runs it.
  Importing submodules eagerly into the facade also creates the cycles that show up as
  `ImportError: cannot import name … (most likely due to a circular import)`.
- Callers import from the facade (`from shop import quote`), never from `shop._pricing`.

## Enforce import rules with import-linter

```toml
[tool.importlinter]
root_package = "shop"
include_external_packages = true          # needed to forbid third-party imports

[[tool.importlinter.contracts]]
name = "Layers"
type = "layers"                           # higher layers may import lower ones, not the reverse
layers = ["shop.api", "shop.services", "shop.domain"]

[[tool.importlinter.contracts]]
name = "Domain has no infrastructure"
type = "forbidden"
source_modules = ["shop.domain"]
forbidden_modules = ["httpx", "sqlalchemy"]
```

Run `uv run lint-imports` in the quality checks and CI; it prints each broken contract
with the import chain and line. `independence` contracts keep sibling packages from
importing each other.

## uv workspaces

```toml
# root pyproject.toml
[tool.uv.workspace]
members = ["packages/*"]

# packages/api/pyproject.toml
[project]
dependencies = ["billing"]

[tool.uv.sources]
billing = { workspace = true }
```

- One `uv.lock` at the root and one shared `.venv`; every member resolves to the same
  versions and must accept a common `requires-python`. Members that need conflicting
  dependency versions do not belong in one workspace; use separate projects with
  `path` sources instead.
- `uv sync --all-packages` installs every member; `uv run --package api …` runs in one
  member's context. The shared `.venv` hides a member's undeclared dependency on a
  sibling's package; `lang-python-quality` shows the `--exact` check.
- `uv init` inside a workspace adds the new package to `members` itself.

## Dependency groups (PEP 735)

```toml
[dependency-groups]
dev = ["pytest>=9", { include-group = "lint" }]
lint = ["ruff", "mypy"]
```

- Groups are for the project's own development: tests, lint, docs. They are not in the
  published metadata. `[project.optional-dependencies]` (extras) are for users of the
  package (`pip install shop[postgres]`).
- `uv add --dev pytest` writes to the `dev` group; `uv add --group lint ruff` to another.
  `uv sync` installs `dev` by default; `--group lint`, `--only-group lint`, `--all-groups`
  and `--no-dev` select others. pip 25.1+ reads them with `pip install --group dev`.
- In a workspace each member's groups are its own; `uv run --package billing` does not
  install the root's `dev` group.
