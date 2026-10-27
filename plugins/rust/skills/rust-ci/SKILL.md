---
name: rust-ci
description: Use when authoring Rust GitHub Actions CI, rust-cache keys, required-check gates, or supply-chain attestation.
metadata:
  opencode/autoinvoke: false
---

# Rust CI Defaults (GitHub Actions)

## Caching & speed

- Cache with `Swatinem/rust-cache@v2`: per-OS `shared-key`, `cache-on-failure`.
- Set `CARGO_INCREMENTAL: 0`.
- Use the toolchain declared by `rust-toolchain.toml` or the package `rust-version`; set
  `>=1.90` only when a dependency or project capability requires Rust 1.90. Set
  `linker = "rust-lld.exe"` for Windows in `.cargo/config.toml`.
- Never select a linker through `RUSTFLAGS`: rust-cache hashes it into the cache key,
  so every job inheriting it misses the cache. Use per-target `[target.<triple>]`
  tables in `.cargo/config.toml` (`linker = …` or `rustflags = ["-C", "link-arg=…"]`);
  they apply only where they match and are not part of the key.
- Install tools from prebuilt binaries (`taiki-e/install-action`, `cargo binstall`),
  not `cargo install`, which compiles from source on every run outside rust-cache.
- Add `mold` (Linux) or `sccache` only when measurements show compile/link still
  dominates. With `sccache`, use an S3/GCS backend -- the GitHub Actions cache
  backend fights `rust-cache` for the 10 GB limit (verify with `sccache --show-stats`).

## Structure

- Filter paths with `dorny/paths-filter` feeding job `if:` conditions. Never put
  `paths:` on a job that is a required check -- skipped required checks deadlock.
- Make ONE `ci-gate` job the sole required status: `if: always()`, needs all
  jobs, `re-actors/alls-green` + `allowed-skips`.
- `fail-fast: false` on the OS matrix; `cancel-in-progress: true` on CI only
  (omit on release workflows mid-upload).

## Supply chain

- SHA-pin third-party actions (e.g. `pinact`).
- Attest released binaries with `actions/attest-build-provenance`
  (needs `id-token: write`, `attestations: write`).
