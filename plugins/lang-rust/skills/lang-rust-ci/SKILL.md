---
name: lang-rust-ci
description: Use when authoring Rust GitHub Actions CI (rust-cache keys, linker placement, prebuilt cargo tools, sccache or mold).
metadata:
  opencode/autoinvoke: false
---

# Rust CI Defaults (GitHub Actions)

Workflow structure (the single required `ci-gate` job, path filters, matrices,
concurrency, SHA-pinned actions, build attestation) is the `toolchain` plugin's
`ci-github-actions` skill. The check steps and their order are `lang-rust-quality`.
This skill is what is specific to Rust.

## Caching & speed

- Cache with `Swatinem/rust-cache@v2`: per-OS `shared-key`, `cache-on-failure`.
- Set `CARGO_INCREMENTAL: 0`.
- Use the toolchain declared by `rust-toolchain.toml` or the package `rust-version`; set
  `>=1.90` only when a dependency or project capability requires Rust 1.90. Set
  `linker = "rust-lld.exe"` for Windows in `.cargo/config.toml`.
- Never select a linker through `RUSTFLAGS` (workflow `env:` or job env): rust-cache
  hashes it into the cache key, so every job inheriting it misses the cache and rebuilds
  the whole dependency graph. Use per-target `[target.<triple>]` tables in
  `.cargo/config.toml` (`linker = …`, or for example
  `[target.x86_64-unknown-linux-gnu] rustflags = ["-C", "link-arg=-fuse-ld=mold"]`);
  they apply only where they match and are not part of the key.
- Never `cargo install` in a workflow `run:` step: it compiles the tool from source on
  every run, before your build starts, outside rust-cache. Install prebuilt binaries:
  `taiki-e/install-action` covers the common tools (`cargo-nextest`, `cargo-llvm-cov`,
  `cargo-deny`, `cargo-shear`, `cargo-machete`, `cargo-audit`, `cargo-mutants`); `cargo binstall` covers the rest.
  Locally, try `cargo binstall <tool>` first and fall back to `cargo install --locked <tool>`
  only when the crate publishes no prebuilt artifact.
- Pin installer actions to full SHAs and tool versions explicitly. Review their
  transitive actions/downloads and verify downloaded artifact integrity (published
  checksums/signatures or attestations) against trusted release metadata. A pinned
  wrapper still needs separate binary version and authenticity checks.
- Add `mold` (Linux) or `sccache` only when measurements show compile/link still
  dominates. With `sccache`, use an S3/GCS backend -- the GitHub Actions cache
  backend fights `rust-cache` for the 10 GB limit (verify with `sccache --show-stats`).

## Steps

- Build and test with `--locked`, so a stale `Cargo.lock` fails instead of being
  rewritten on the runner.
- With nextest, run `cargo test --doc` as its own step; nextest skips doc tests.
- sqlx offline builds: `cargo sqlx prepare --check` (see `lang-rust-persistence`).
- `fail-fast: false` on the OS matrix: a Windows-only failure stays visible.
- Mutation on pull requests: check out with `fetch-depth: 0`, then
  `git diff origin/$BASE.. > git.diff` and
  `cargo mutants --in-place --no-shuffle -vV --in-diff git.diff` under the default
  `cargo test` (doctests included). Scheduled full runs shard with `--shard k/n` in a
  matrix using identical arguments. Upload `mutants.out` with `if: always()`.
- Miri or `cargo +nightly careful test` run on a schedule for crates with unsafe code.
- `cargo semver-checks` (`obi1kenobi/cargo-semver-checks-action@v2`) for published libraries.
- Docs: `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features`.
- Install policy: a tool the project lacks is detected, recommended and installed only
  after the user agrees; tool choices are in `lang-rust-libraries`.
