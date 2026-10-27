---
name: lang-rust
description: "Use for Rust work: fmt/clippy/tests, nextest, proptest, insta, CI, crates, workspaces, sqlx, Tauri, profiling."
---

# Rust

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Running Rust format, lint (clippy) or test checks | `lang-rust-quality` |
| Writing or fixing Rust tests: unit and integration layout, nextest, doc tests, proptest, insta snapshots, tokio | `lang-rust-testing` |
| Splitting crates, `lib.rs` facades, Cargo workspace layout, workspace lints and dependencies, feature-gated dev code | `lang-rust-packaging` |
| Rust GitHub Actions CI: rust-cache keys, linker placement, prebuilt cargo tools, sccache or mold | `lang-rust-ci` |
| Persistence crates with sqlx: `migrate!`, `build.rs` reruns, offline `.sqlx` data, CAS updates, `#[sqlx::test]` | `lang-rust-persistence` |
| Tauri v2 desktop apps: bundles, release-please, updater, signing, WebDriver E2E | `lang-rust-tauri` |
| Rust profilers and benchmarks: samply, cargo flamegraph, perf, criterion | `lang-rust-profiling` |

Rust design is the `quality-code-design` skill: its `rust.md` reference covers error
enums, newtypes and serde wrappers; `contracts.md` generated bindings, invoke names and
wire casing; `safe-mutation.md` plan/approve/apply flows.
