# Monorepo

Ask first whether it needs to be one. One repository with one language usually wants that
language's workspace (below), not a polyglot layout. Layout and ownership rules:
`architecture-top-level` and `architecture-ownership`.

## One language: use its workspace

- Rust: virtual Cargo workspace, `crates/*`. See `rust.md`, `lang-rust-packaging`.
- Python: uv workspace, `packages/*`, one root `uv.lock`. See `python.md`, `lang-python-packaging`.
- Go: one module with `cmd/` and `internal/`; extra modules only if released separately.
- TypeScript: bun workspaces (`packages/*`, `apps/*`) with `catalog:` versions and project
  references; for apps use Better-T-Stack (`typescript.md`), with `turborepo` or `nx` as an
  addon only if the user wants a task orchestrator.

## Several languages

1. Top level by capability, not by language (`architecture-top-level`): for example
   `apps/web` (TypeScript), `services/api` (Go), `crates/core` (Rust), plus `docs/`.
2. Each member is set up from its own reference, inside its directory (`cargo new`,
   `uv init`, `go mod init`, Better-T-Stack with a project directory), without nested git
   repositories (`--vcs none` / `--no-git`).
3. Root owns: `.git`, `mise.toml` pinning every runtime, `justfile` with `just check`
   fanning out to each member's gate, the license, `docs/`, `AGENTS.md`, CI, release
   config, hooks. Members own their manifests and lockfiles.
4. Orchestration: `just` for aliases; `moon` for task orchestration in a large repo
   (`toolchain-stack-defaults`); ask which. Do not add both without a reason.
5. CI: one workflow, one `ci-gate` job, per-member jobs gated by `dorny/paths-filter`
   outputs, never `paths:` on the trigger (`ci-github-actions`).
6. Releases: ask whether members version together or separately; release-please supports
   per-path components (`trunk-dev-release-setup`).
7. Put a short `AGENTS.md` in a member only when its rules differ from the root.

Adding a member to an existing monorepo: `brownfield.md` (no nested git repos, root CI must
cover the member's language, re-run the root checks).
