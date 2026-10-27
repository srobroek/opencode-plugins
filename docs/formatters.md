# Formatters, linters and tests

omp-plugins shipped `go_quality`, `python_quality`, `typescript_quality` and
`rust_quality` tools that ran a format check, a linter and the tests. In OpenCode
the formatting half is built in, and the rest is a shell command the agent runs
from a skill. No plugin replaces the tools.

## Enable the built-in formatters

Formatters are off by default. Turn them on in `opencode.json` (global or project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "formatter": true,
}
```

OpenCode then formats each file after its `edit`, `write` or `patch` tool changes
it, using the first built-in that matches the extension and whose requirement is
met. For the languages the omp tools covered:

| Language | Built-in | Requirement |
| --- | --- | --- |
| Go | `gofmt` | `gofmt` on `PATH` |
| Python | `ruff`, `uv` | `ruff` with a Ruff config or dependency, or `uv` with `uv format` |
| TypeScript, JavaScript | `biome`, `prettier`, `oxfmt` | `biome.json(c)` and `@biomejs/biome`, or `prettier`/`oxfmt` in `package.json` |
| Rust | `rustfmt` | `rustfmt` on `PATH` |

An object instead of `true` overrides or disables single formatters, for example
`"formatter": { "prettier": { "disabled": true } }`. See the
[Formatters guide](https://opencode.ai/v2/docs/formatters/) for every built-in and
custom formatter fields.

The formatter only touches files those tools write. Keep the format check in the
commands below for files changed any other way (a shell command, a generator, a
checkout).

## Lint, type-check and test commands

The agent runs these through the `shell` tool, from the project root. The skills
listed carry the full guidance: order, narrowing, and how to report a step that
could not run.

| Language | Check | Fix | Skill |
| --- | --- | --- | --- |
| Go | `go build ./...`, `golangci-lint fmt --diff` (or `gofmt -l .`), `golangci-lint run` (or `go vet ./...`), `go test -race ./...`, `go mod tidy -diff`, `govulncheck ./...` | `golangci-lint fmt` or `gofmt -w .` | `lang-go-quality` (lang-go plugin) |
| Python | `uv lock --check`, `ruff check .`, `ruff format --check .`, `mypy` or `pyright`, `pytest -x` | `ruff check --fix .`, `ruff format .` | `lang-python-quality` (lang-python plugin) |
| TypeScript | frozen-lockfile install, `biome check .` or `eslint .`, `tsc -b` or `tsc --noEmit`, the test script | `biome check --write .` or `eslint . --fix` | `lang-typescript-quality` (lang-typescript plugin) |
| Rust | `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test` | `cargo fmt` | `lang-rust-quality` (lang-rust plugin) |

Prefix Python commands with `uv run` or `poetry run` when the project uses them, and
run TypeScript tools through the project's package manager (`bunx`, `pnpm exec`,
`npx`) so that only project-installed versions run.

To skip a permission prompt for these commands, allow them in `permissions`, for
example `{ "action": "shell", "resource": "cargo clippy *", "effect": "allow" }`.
