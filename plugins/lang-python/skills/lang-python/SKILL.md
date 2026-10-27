---
name: lang-python
description: "Use for Python work: ruff, mypy/pyright, pytest, hypothesis, uv workspaces, pydantic, SQLAlchemy/Alembic, profiling."
---

# Python

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Running Python lock, lint, format, type-check and test checks, locally or in CI | `lang-python-quality` |
| Writing or fixing Python tests: pytest fixtures, parametrize, monkeypatch, Hypothesis property tests, coverage | `lang-python-testing` |
| Python package layout: src layout, `__init__` facades and `__all__`, import-linter, uv workspaces, dependency groups | `lang-python-packaging` |
| Python typing: mypy or pyright strict, Protocol, TypedDict, pydantic boundary models, datamodel-codegen | `lang-python-types` |
| SQLAlchemy sessions, Alembic migrations, autogenerate review, migration CI checks, database tests | `lang-python-persistence` |
| Python profilers and benchmarks: py-spy, scalene, memray, cProfile | `lang-python-profiling` |

Python design (functions, protocols, exception hierarchies) is the `quality-code-design`
skill's `python.md` reference.
