# Python quality

Checked 2026-01-10.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `lint` | `ruff` | >= 0.9.0 · 2026-01-05 · active | `ruff --version` · `uv tool install ruff` | None | - | every-pr | - |
| `types` | `mypy` | >= 1.14.0 · 2026-01-04 · active | `mypy --version` · `uv tool install mypy` | None | - | every-pr + scheduled | - |
