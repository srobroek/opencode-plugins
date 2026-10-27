# lang-rust

Rust guidance for OpenCode as skills: the format, lint and test commands, testing
idioms, crate and workspace layout, CI, sqlx persistence and Tauri defaults, and
profiling. Language-neutral design (error enums and newtypes, generated bindings and
wire casing, plan/approve/apply flows) is in the `quality` plugin's `quality-code-design`
skill and its `rust.md`, `contracts.md` and `safe-mutation.md` references.
The plugin ships no hooks.

Replaces the former `rust` plugin, ported from the omp-plugins `rust` plugin. The omp
`rust_quality` tool is not ported: `rustfmt` runs as OpenCode's built-in formatter
(`"formatter": true`, see [docs/formatters.md](../../docs/formatters.md)), and the
`lang-rust-quality` skill lists the `cargo fmt`, `cargo clippy` and `cargo test` commands to
run through the shell tool. The `rust` plugin's advisories are gone: the `cargo install`
and `RUSTFLAGS` linker advice is in `lang-rust-ci`, and the toolchain plugin's
`ops-no-global-cargo-target` skill covers a global target directory (the advisory's
per-worktree advice contradicted its repository-scoped target). The migration-edit gate is in the
[safety](../safety/README.md#migration-edit) plugin.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/lang-rust'
```

Claude Code and Codex install the same skills from this repository's marketplace:

```sh
claude plugin install lang-rust@srobroek-opencode
codex plugin add lang-rust@srobroek-opencode
```

## Skills

Only `lang-rust` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.
The profiling skill is also reached through the `quality` plugin's `quality-profiling` skill.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `lang-rust`: the router.
- `lang-rust-quality`: format, lint and test commands.
- `lang-rust-testing`: unit and integration layout, nextest, doc tests, proptest, insta,
  tokio paused time.
- `lang-rust-packaging`: crate splits, `lib.rs` facades, workspace manifest, lints and
  dependencies, feature-gated dev code.
- `lang-rust-ci`: rust-cache, `CARGO_INCREMENTAL`, linker placement, prebuilt tools,
  sccache or mold. Workflow structure is the `toolchain` plugin's `ci-github-actions`.
- `lang-rust-persistence`: persistence crate, `migrate!` and `build.rs` reruns, offline
  `.sqlx` data, `rows_affected` CAS, `#[sqlx::test]`.
- `lang-rust-profiling`: samply, cargo flamegraph, perf and criterion baselines; the
  method is the `quality` plugin's `quality-profiling` skill.
- `lang-rust-tauri`: Tauri v2 bundles, updater, WebDriver, and the MCP bridge reference.
