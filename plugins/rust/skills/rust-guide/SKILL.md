---
name: rust-guide
description: "Use for Rust work: fmt/clippy/tests, CI, crates, workspaces, errors, sqlx/SQLite, bindings/IPC, Tauri, safe mutation."
---

# Rust guide

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Running Rust format, lint (clippy) or test checks | `rust-quality` |
| Rust GitHub Actions CI, rust-cache keys, required checks, supply-chain attestation | `rust-ci` |
| Splitting crates, workspace layout, `lib.rs` facades, extracting IO from a domain crate | `rust-crate-boundaries` |
| Cargo workspace lints, `workspace.dependencies`, feature-gated dev surfaces, layered tests | `rust-workspace` |
| Error enums, newtypes, serde-transparent wrappers | `rust-domain-modeling` |
| SQLite/sqlx repositories, numbered migrations, CAS-in-transaction updates, embed-macro rebuilds | `rust-persistence` |
| Generated bindings, codegen drift guards, pinned IPC invoke names, wire casing | `rust-contract-boundary` |
| Plan/approve/apply flows, TOCTOU CAS freshness, path traversal checks, mutation audits | `rust-safe-mutation` |
| Tauri v2 desktop apps: bundles, release-please, updater, signing, WebDriver E2E | `rust-tauri` |
| Rust profilers and benchmarks: samply, cargo flamegraph, perf, criterion | `lang-rust-profiling` |
