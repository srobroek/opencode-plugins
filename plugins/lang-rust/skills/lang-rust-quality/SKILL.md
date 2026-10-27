---
name: lang-rust-quality
description: Use to run Rust format, lint, and test checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
---

# Rust Quality

Run the checks through the shell tool from the crate or workspace root (the
directory with `Cargo.toml`):

| Step | Command |
| --- | --- |
| Format check | `cargo fmt --check` |
| Lint | `cargo clippy --all-targets --all-features -- -D warnings` |
| Test | `cargo test` |
| Format fix | `cargo fmt` |

Run them in that order and stop at the first failure you need to fix. In a
workspace, add `--workspace` to clippy and test, or `-p <crate>` to narrow them.
Use `cargo nextest run` instead of `cargo test` when the project already uses
nextest, plus `cargo test --doc`, because nextest does not run doc tests.

CI runs the same steps with `--locked`; the Rust-specific workflow settings are in
`lang-rust-ci`.

In OpenCode, formatting after an edit is the host's job: with `"formatter": true` in
`opencode.json`, the built-in `rustfmt` formatter rewrites each `.rs` file after the
`edit`, `write` or `patch` tool changes it. `cargo fmt --check` still belongs in the
check, because files changed outside those tools are not formatted.

A missing `Cargo.toml` or `cargo` means the check did not run. Report it as not run,
never as a pass. Read failures as the project's actual toolchain output; do not
invent extra linters.

In OpenCode, the rust plugin refuses edits to a committed migration: only the
highest-numbered entry under a `migrations/` directory is editable. Write a new
migration instead.
