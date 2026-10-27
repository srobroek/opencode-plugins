---
name: lang-rust-packaging
description: Use for Rust crate splits and Cargo workspaces (lib.rs facades, workspace lints and dependencies, feature-gated dev code).
metadata:
  opencode/autoinvoke: false
---

# Rust Packaging

Sources: [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html), [`[lints]`](https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section), [features](https://doc.rust-lang.org/cargo/reference/features.html), [resolver versions](https://doc.rust-lang.org/cargo/reference/resolver.html#resolver-versions).

Keep existing project choices unless the task is about setup, refactor, or
standardization. Error enums, newtypes and serde wrappers are the `quality-code-design`
skill's `rust.md` reference.

## Crate boundaries

- Each crate MUST compile without forcing an IO, DB, or UI rebuild. That constraint,
  not file count, decides where a split goes.
- When IO or network creeps into a domain crate, extract it into a sibling adapter
  crate instead of feature-gating it in place.
- `lib.rs` is a thin facade: module declarations and curated re-exports. Logic sitting
  in `lib.rs` is logic that leaked out of the module owning it -- push it down.
  Top-level legacy aliases are a migration smell.
- Keep items `pub(crate)` unless another crate uses them; everything `pub` from the
  facade is API that other crates will start depending on.

## Workspace manifest

```toml
# Cargo.toml (virtual workspace root)
[workspace]
members = ["crates/*"]
resolver = "3"                 # a virtual workspace has no package edition to imply it

[workspace.package]
edition = "2024"
rust-version = "1.90"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
billing-domain = { path = "crates/billing-domain" }

[workspace.lints.rust]
unsafe_code = "forbid"

[workspace.lints.clippy]
pedantic = { level = "warn", priority = -1 }
```

```toml
# crates/billing-api/Cargo.toml
[package]
name = "billing-api"
edition.workspace = true
rust-version.workspace = true

[dependencies]
serde.workspace = true
billing-domain.workspace = true

[lints]
workspace = true
```

- Workspace lints belong in `[workspace.lints]`; members inherit them with
  `[lints] workspace = true`. A lint group needs `priority = -1` so individual lints
  can override it.
- Keep semver ranges in `[workspace.dependencies]`; members use `{ workspace = true }`
  (adding features locally if needed). Do not pin patch-level without a known
  breakage; document the reason. Bump once per workspace.
- Keep dev dependencies in the crate that uses them. Add a shared `tests-common`
  library only when multiple crates share elaborate fixtures. Keep automation
  dependencies in CI/toolchain files, not `[dev-dependencies]`.
- Keep unit, integration, and end-to-end tests in the crate or workspace layer that
  owns them. Use targeted package tests (`-p <crate>`) while unrelated packages are red.

## Feature-gated dev surface

- Dev/testing/debug surface: a default-off Cargo feature (`#[cfg(feature = "…")]`),
  not a runtime flag.
- The gate propagates: the edge binary declares it, the app crate enables it, leaf
  crates compile the code only when it is enabled
  (`[features] debug-api = ["billing-domain/debug-api"]`).
- Release binaries build with the feature off -- the code is absent at compile time.
- Features are additive and unified across the workspace build: a feature one member
  enables is on for every crate in that build. Check the release binary on its own
  (`cargo build -p app --release`) to confirm the gate is off, and run
  `cargo clippy --all-features` so gated code stays compiling.
