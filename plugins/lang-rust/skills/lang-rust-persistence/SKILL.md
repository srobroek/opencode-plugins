---
name: lang-rust-persistence
description: Use for Rust SQLite/sqlx repositories, numbered migrations, CAS-in-transaction updates or embed-macro rebuilds.
metadata:
  opencode/autoinvoke: false
---

# Rust Persistence Defaults

- DB is the durable record; on-disk artifacts are reproducible projections.
- Isolate persistence in its own crate behind a thin handle owning the connection pool.
- State transitions: atomic CAS inside a transaction (`UPDATE … WHERE state = expected`);
  zero rows → distinguish not-found vs CAS-failed by re-reading. No SELECT-then-write on a bare pool.
- Migrations: numbered, embedded, append-only. Never edit one that has shipped; add a new one.
  In OpenCode the safety plugin refuses writes to a migration that has already shipped.
- Migration prefix collision gotcha: parallel branches each grabbing the next number collide --
  add a CI duplicate-prefix guard.
- Embed macro gotcha: a new migration file goes unapplied until the crate recompiles.
  Add `cargo:rerun-if-changed=migrations` in `build.rs`.
- Dynamic SQL: build from static fragments only; always bind values.
- Tests: real in-memory DB running real migrations -- no mock DB.
