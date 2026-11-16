# Python testing

Checked 2026-01-10.

## Concerns

| Concern | Default | Maintenance | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|
| `unit` | `pytest` | 8.3.0 · 2026-01-02 · active | `unittest`: no dependencies allowed; nose2: legacy suites | - | every-pr + diff-pr | Plugins that patch internals |

## Tradeoffs

### unit

- **pytest**: fixtures and parametrize.
- **unittest**: standard library only.

## Language-specific

| Topic | Note |
|---|---|
| Fixtures | Put them in conftest. |
