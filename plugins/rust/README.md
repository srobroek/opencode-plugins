# rust

Rust guidance for OpenCode: advisories for slow or cache-breaking Cargo setups,
and skills with crate, workspace, CI, persistence and Tauri defaults.

Ported from the omp-plugins `rust` plugin. The omp `rust_quality` tool is not
ported: `rustfmt` runs as OpenCode's built-in formatter (`"formatter": true`, see
[docs/formatters.md](../../docs/formatters.md)), and the `rust-quality` skill lists
the `cargo fmt`, `cargo clippy` and `cargo test` commands to run through the shell
tool.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/rust'
```

Claude Code and Codex install the skills from this repository's marketplace:

```sh
claude plugin install rust@srobroek-opencode
codex plugin add rust@srobroek-opencode
```

There the skills have no advisories behind them.

## Migration gate

The migration-edit gate moved to the [safety](../safety/README.md#migration-edit)
plugin, which covers every language's migration layout and reads from git which
migrations have shipped.

## Advisories

A `tool.hook("execute.after")` appends a note to a completed call's result, at most
once per session for each advisory:

| Advisory | Fires on |
| --- | --- |
| `cargo install` | A `shell` command that runs `cargo install` (not `--help`), or a `.github/workflows/*.yml` edit that adds a `cargo install` run line. Suggests `taiki-e/install-action` or `cargo binstall`. |
| `RUSTFLAGS` linker | A workflow edit that adds `RUSTFLAGS` with `linker` or `link-arg`. rust-cache hashes `RUSTFLAGS` into its key; suggests per-target `.cargo/config.toml` tables. |
| Global target dir | An edit to `~/.cargo/config.toml` (or `$CARGO_HOME/config.toml`) that adds `target-dir =`, or an edit or shell write to a shell profile (`.zshrc`, `.bashrc`, `.profile`, `config.fish`, …) that sets `CARGO_TARGET_DIR`. A shared target directory serializes builds across worktrees on Cargo's lock. |

Edits are judged by the text they add (`newString`, `content`, a patch's `+` lines).

## Skills

Only `rust-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to one of the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `rust-quality`: format, lint and test commands.
- `rust-crate-boundaries`: crate splits, facades, adapters.
- `rust-domain-modeling`: thiserror and serde newtypes.
- `rust-contract-boundary`: generated bindings and wire casing.
- `rust-safe-mutation`: plan/approve/apply and CAS.
- `rust-ci`: rust-cache, ci-gate, attestation, linker placement, prebuilt tools.
- `rust-persistence`: sqlx, migrations, transactional CAS.
- `rust-workspace`: workspace lints, dependencies, and layered tests.
- `lang-rust-profiling`: samply, cargo flamegraph, perf and criterion baselines; the
  method is the `quality` plugin's `quality-profiling` skill.
- `rust-tauri`: Tauri v2 bundles, updater, WebDriver, and the MCP bridge reference.
