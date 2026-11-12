# Rust

Load `lang-rust` (router) for quality, testing, packaging and CI detail; `toolchain-languages` for picks.

## Init

```sh
mise use rust@stable           # or rustup alone; ask which owns the toolchain
cargo new <name> --bin         # or --lib; add --vcs none inside an existing git repo
```

Pin the channel in `rust-toolchain.toml` (`components = ["rustfmt", "clippy"]`). Edition
2024. Workspace for more than one crate: virtual root `Cargo.toml` with
`resolver = "3"`, `members = ["crates/*"]`, `[workspace.package]`,
`[workspace.dependencies]`, `[workspace.lints]` (see `lang-rust-packaging`).

## Preferred tools and libraries

| Need | Pick |
| --- | --- |
| Errors | `thiserror` in libraries, `anyhow` in binaries |
| CLI | `clap` |
| Format / lint | `rustfmt`; `clippy` with `-D warnings` |
| Tests | `cargo nextest run` plus `cargo test --doc` for library crates |
| Coverage | `cargo llvm-cov nextest --lcov` |
| Dependency gate | `cargo deny check` (advisories, bans, licenses, sources); `deny.toml` allowlist of MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unicode-3.0, Zlib (SPDX ids) |
| Unused deps | `cargo machete` (part of the gate); pilot `cargo-shear` for misplaced dependencies instead of stacking gates. `cargo-udeps` is a nightly diagnostic fallback |
| Add deps | `cargo add`, never hand-edit tables |
| Database | `sqlx` (`lang-rust-persistence`); desktop `Tauri` v2 (`lang-rust-tauri`) |

Async runtime, HTTP, logging and serialization crates: use `serde` for serialization;
ask the user for the rest (the sources are silent on them). Structured logging and
OpenTelemetry follow `toolchain-quality-observability`.

## Gate (`just check`)

`cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`,
`cargo nextest run --workspace`, `cargo test --doc` (only when a crate has a library target;
a `--bin`-only crate has no doctests and the command fails), `cargo deny check`, `cargo machete`. CI adds `--locked`
and installs tools with `taiki-e/install-action` (`lang-rust-ci`). Commit `Cargo.lock`
for binaries.

Check the supported feature/target matrix before deleting dependencies or treating
`--all-features` as sufficient (some features are mutually exclusive). Keep rustc
`dead_code` warnings; dependency scanners do not replace them. Clippy
`cognitive_complexity` is an opt-in restriction lint whose documentation warns it
does not measure true cognitive complexity; do not enable it as a universal gate.

Pin `cargo-nextest`, `cargo-deny`, `cargo-machete` and `cargo-llvm-cov` in mise (or install
them in CI with `taiki-e/install-action`). Add `clippy.toml` with `allow-unwrap-in-tests = true`
and `allow-expect-in-tests = true` if the user wants unwrap allowed in tests only.
If the project is unlicensed, set `[licenses.private] ignore = true` in `deny.toml`.

## Rules

- No machine-global `CARGO_TARGET_DIR`; `target/` stays per repository
  (`ops-no-global-cargo-target`). Share compiles with sccache (`ops-toolchain-cache-policy`).
- Keep `.gitignore` entry `/target`.
