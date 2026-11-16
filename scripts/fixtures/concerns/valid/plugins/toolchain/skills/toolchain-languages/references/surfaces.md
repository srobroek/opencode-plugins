# Surfaces

Checked 2026-01-10.

## web

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `e2e` | `playwright` | >= 1.50.0 · 2026-01-07 · active | `playwright --version` · `npm i -D @playwright/test` | `cypress`: team already owns suites; `selenium`: legacy grid | - | every-pr + scheduled | - |
| `visual` | Built-in: playwright screenshots | - | Built-in | None | - | diff-pr | - |

### Tradeoffs

#### e2e

- **playwright**: multi-browser and fast; costs a browser download.
- **cypress**: good debugging UI; costs single-tab limits.
- **selenium**: runs legacy grids; slow and flaky.

## api

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `e2e` | `hurl` | >= 6.0.0 · 2026-01-08 · active | `hurl --version` · `brew install hurl` | None | - | every-pr + scheduled | - |
| `visual` | N/A: no pixels | - | - | None | - | - | - |
