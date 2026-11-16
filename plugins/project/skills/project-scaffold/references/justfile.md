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
| Go | `gofmt -w` / `golangci-lint fmt --diff` | `golangci-lint run ./...` | (vet/staticcheck in lint) | `go test -race ./...` | `go test -race -coverprofile=coverage.out -covermode=atomic ./...` then `go tool cover -func=coverage.out` | `go tool govulncheck ./...`, `go mod tidy -diff`; install `go mod download` |
| TypeScript | `bunx biome check --write .` / `biome check .` (or selected formatter) | Selected Biome 2, ESLint 10 or optional Oxlint stack (`typescript.md`), not mandatory Oxlint | `bunx tsc --noEmit` | `bun test` or `vitest run` | `vitest run --coverage` or `bun test --coverage` | Knip 6 (`bunx knip`); install `bun install --frozen-lockfile` |

## Depth tasks (not part of `check`)

Each task maps to a Run token from `toolchain-languages` (`references/concerns.md`). Each
language's tool is the Default in its concerns table; use the project's existing tool if it
has one. Tools are detected and installed under the install policy there (ask first); the
tasks never install anything. Add only the tasks whose concern the project has chosen.

| Task | Run token | Behaviour |
| --- | --- | --- |
| `mutate-diff` | diff-pr | mutate only the code changed against `origin/main`; report survivors |
| `mutate` | scheduled | full or sharded mutation run |
| `fuzz-smoke` | bounded-pr | each target for about 60 seconds, corpus and crashers kept |
| `fuzz` | scheduled | long campaign; time is a variable (`just fuzz 3600`) |
| `api-break` | every-pr + release | libraries only; compare against the last release or `origin/main` |
| `docs` | every-pr | build the API reference with warnings as errors |
| `flaky` | scheduled | shuffled order and repeated runs; print the seed |

| Lang | mutate-diff / mutate | fuzz-smoke / fuzz | api-break | docs | flaky |
| --- | --- | --- | --- | --- | --- |
| Rust | `git diff origin/main... > git.diff; cargo mutants --in-place --in-diff git.diff` / `cargo mutants --in-place` (CI: `--shard k/n`) | `cargo fuzz run <target> -- -max_total_time=60` / same with a longer `-max_total_time` | `cargo semver-checks` | `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps` | `cargo nextest run --stress-count 20`; `cargo +nightly test -- -Z unstable-options --shuffle` |
| Go | `go tool gremlins unleash --diff origin/main` / `go tool gremlins unleash` | `go test -run='^$' -fuzz=<Fuzz> -fuzztime=60s <pkg>` / longer `-fuzztime` (one `-fuzz` target per run) | `go tool go-apidiff origin/main` | `go vet ./...` and `go doc` checks via lint (`godoclint`) | `go test -shuffle=on -count=5 ./...` |
| Python | `uv run --locked mutmut run` on the changed modules (`paths_to_mutate`) / on all selected modules | `uv run --locked python fuzz/<target>.py -max_total_time=60 corpus/` (Atheris) / longer | `uv run --locked griffe check <pkg> --against <last-tag>` | `uv run --locked sphinx-build -W docs docs/_build` | `uv run --locked pytest -p randomly` (note the printed seed); `pytest --count=10` with `pytest-repeat` |
| TypeScript | `bunx stryker run --incremental --mutate <changed files>` / `bunx stryker run --incremental` | Jazzer.js: `npx jazzer fuzz/<target> --sync -- -max_total_time=60` (Node) / longer | `attw --pack .`, `publint`, `api-extractor run` | `typedoc` | `vitest run --sequence.shuffle --repeats=5` or `bun test --randomize` |
| Shell | forced-fault loop over the changed scripts, bats under `timeout` | N/A | `bats` CLI contract tests | `shdoc` | `bats --jobs 4 tests/` repeated; use `BATS_TEST_TMPDIR` |
| Terraform | N/A | N/A | contract test on module outputs | `terraform-docs` | N/A |
| CDK | N/A | N/A | `jsii-diff` (construct libraries only) | `jsii-docgen` (construct libraries only) | N/A |

Shell gate: `shellcheck -x`, `shfmt -d -ln bash`, `bats tests/`; coverage `kcov` in Linux CI.
Terraform gate: `terraform fmt -check -recursive`, `terraform init -backend=false` then
`terraform validate`, `tflint`, `terraform test`, `checkov -d .`, `terraform-docs`; plan and
drift are CI (`ci-hooks.md`). CDK gate: `cdk synth` (with `cdk-nag`), template assertions,
`cfn-lint cdk.out/*.template.json`; `cdk diff --fail-on=broadening` is the CI plan check.

Mutation, fuzz and flaky tasks are depth checks: a failure reports, and blocks only where
`ci-hooks.md` says so.

Capability gates join `check`: `api` (`api-lint`, `api-breaking`), `i18n`, `a11y`,
`aws-cdk` (synth, `cdk-nag`; `cdk diff` in CI). Add `deadcode`, `audit` and `sbom` tasks only for configured scanners
and release needs; use the language picks and `ci-hooks.md`, not mandatory duplicate scans.
Python check tasks use `uv run --locked`; keep fixing separate. Docs checks: `python-docs` style advisory tasks (`ruff check --select D
--exit-zero`) never fail the gate. A formatter or safe lint fix does not belong in `check` (see Fixer hooks).
Dependency bumps are the Renovate or Dependabot job; do not look up latest versions during
setup beyond picking current stable.
