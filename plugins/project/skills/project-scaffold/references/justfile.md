# justfile

One task surface for humans, hooks, worktrunk and CI. Keep the root `justfile` small and put
per-layer tasks in `.just.d/<layer>.just` imported with `import?` (the optional form: a
missing file then breaks only its own tasks), or in the root file for a small project. Every
tool a task invokes must be pinned in `mise.toml` (or `.mise/conf.d/<layer>.toml`), including
`just` itself, `prek`, `jq` and linters. Use `set shell := ["bash", "-uc"]` and no bash 4
features (macOS ships bash 3.2: no `mapfile`).

## Aggregates

| Task | Behaviour |
| --- | --- |
| `setup` | fresh clone: `mise trust --yes`, `mise install --yes`, per-language install tasks, hook install (`prek install --git-dir "$(git rev-parse --absolute-git-dir)"`), capability installs |
| `setup-worktree` | the shorter list for a linked worktree after copied caches: trust, per-language install (cheap refresh), hook install (a worktree's git dir differs, so shims must be installed per worktree), capability installs |
| `check` | no formatter or lint fixer in write mode; the baseline hygiene hooks may rewrite (see Fixer hooks): hooks on all files, then each language gate and each capability gate present |
| `each <phase>` | one phase (`fmt`, `lint`, `test`, `types`, `cov`) across every language |
| `fmt` | the writers |
| `dev` / `run` | only if the project serves or runs something |

When mise scopes matter, `mise install` with a global config installs the developer's whole
collection; install the project's tools only (point `MISE_GLOBAL_CONFIG_FILE` at an empty
file for that one command).

## Fixer hooks in `check`

`check` runs the prek hooks on all files, and the baseline hygiene hooks (trailing-whitespace,
end-of-file-fixer, mixed-line-ending) fix files as well as report them. On a local run they may
rewrite files and exit non-zero; that is expected, so review the diff and rerun the gate until
it passes. CI runs the same hooks and fails on any change, so commit what they rewrote. Do not
claim `check` "only checks" or skip these hooks to keep it read-only.

Formatters and safe lint fixes (`cargo fmt`, `ruff format`, `ruff check --fix`, `gofmt -w`,
`biome check --write`) stay in `just fmt`. Never let `check` run a formatter in write mode; it
uses the `fmt-check` form instead.

## Per-language tasks (names `<lang>-<phase>`)

| Lang | fmt / fmt-check | lint | types | test | coverage | dependency and security |
| --- | --- | --- | --- | --- | --- | --- |
| Rust | `cargo fmt --all` / `--check` | `cargo clippy --all-targets --all-features -- -D warnings` | (clippy) | `cargo nextest run --all-features --no-tests=pass` | `cargo llvm-cov nextest --all-features --no-tests=pass --lcov --output-path lcov.info` | `cargo deny check`, `cargo machete`; install `cargo fetch --locked` |
| Python | `uv run ruff format .` / `--check` | `uv run ruff check .` | `uv run pyright` | `uv run pytest` | `uv run pytest --cov --cov-report=term-missing --cov-report=lcov` | `uv run deptry .`; matrix `uv run nox`; install `uv sync --frozen` |
| Go | `gofmt -w` / `golangci-lint fmt --diff` | `golangci-lint run ./...` | (vet/staticcheck in lint) | `go test -race ./...` | `go test -race -coverprofile=coverage.out -covermode=atomic ./...` then `go tool cover -func=coverage.out` | `govulncheck ./...`, `go mod tidy -diff`; install `go mod download` |
| TypeScript | `bunx biome check --write .` / `biome check .` | `bunx oxlint` (optional, see `typescript.md`) | `bunx tsc --noEmit` | `bun test` or `vitest run` | `vitest run --coverage` or `bun test --coverage` | `bunx knip`; install `bun install --frozen-lockfile` |

Capability gates join `check`: `api` (`api-lint`, `api-breaking`), `i18n`, `a11y`,
`aws-cdk` (synth). Docs checks: `python-docs` style advisory tasks (`ruff check --select D
--exit-zero`) never fail the gate. A formatter or safe lint fix does not belong in `check` (see Fixer hooks).
Dependency bumps are the Renovate or Dependabot job; do not look up latest versions during
setup beyond picking current stable.
