---
name: lang-rust
description: "Use for Rust work: new crates, fmt/clippy/tests, CI, workspaces, errors, persistence/sqlx, bindings, Tauri, profiling."
---

# Rust

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Running Rust format, lint (clippy) or test checks | `lang-rust-quality` |
| Rust GitHub Actions CI, rust-cache keys, required checks, supply-chain attestation | `lang-rust-ci` |
| Splitting crates, workspace layout, `lib.rs` facades, extracting IO from a domain crate | `lang-rust-crate-boundaries` |
| Cargo workspace lints, `workspace.dependencies`, feature-gated dev surfaces, layered tests | `lang-rust-workspace` |
| Error enums, newtypes, serde-transparent wrappers | `lang-rust-domain-modeling` |
| Persistence crates, SQLite/sqlx repositories, numbered migrations, CAS-in-transaction updates, embed-macro rebuilds | `lang-rust-persistence` |
| Generated bindings, codegen drift guards, pinned IPC invoke names, wire casing | `lang-rust-contract-boundary` |
| Plan/approve/apply flows, TOCTOU CAS freshness, path traversal checks, mutation audits | `lang-rust-safe-mutation` |
| Tauri v2 desktop apps: bundles, release-please, updater, signing, WebDriver E2E | `lang-rust-tauri` |
| Rust profilers and benchmarks: samply, cargo flamegraph, perf, criterion | `lang-rust-profiling` |
