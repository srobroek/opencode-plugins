---
name: lang-rust-persistence
description: Use for Rust persistence crates with sqlx (migrate!, build.rs reruns, offline .sqlx data, CAS updates, sqlx::test).
metadata:
  opencode/autoinvoke: false
---

# Rust Persistence (sqlx)

Sources: [`sqlx::migrate!`](https://docs.rs/sqlx/latest/sqlx/macro.migrate.html), [`#[sqlx::test]`](https://docs.rs/sqlx/latest/sqlx/attr.test.html), [sqlx-cli](https://github.com/launchbadge/sqlx/blob/main/sqlx-cli/README.md).

The language-neutral rules (the database is the record, compare-and-set transitions,
append-only numbered migrations with a duplicate-prefix CI guard, static SQL fragments
with bound values, real-database tests) are the `quality-code-design` skill's
`persistence.md` reference. This skill is the Rust and sqlx specifics.

- Isolate persistence in its own crate behind a thin handle owning the connection
  pool, so domain crates compile without sqlx and a schema change rebuilds one crate.
- State transitions: one conditional `UPDATE … WHERE id = $1 AND state = $2` inside
  `pool.begin()`; check `result.rows_affected()`. Zero rows: re-read to tell not-found
  from CAS-failed. No SELECT-then-write on a bare pool.
- Migrations embed with `sqlx::migrate!()` and run with `.run(&pool)` at startup. In
  OpenCode the safety plugin refuses writes to a migration that has already shipped.
- Embed macro gotcha: a new migration file goes unapplied until the crate recompiles.
  Add `println!("cargo:rerun-if-changed=migrations");` to `build.rs`
  (`sqlx migrate build-script` writes it).
- `query!` / `query_as!` check SQL against a live database at compile time. For builds
  without one, commit the `.sqlx/` directory from `cargo sqlx prepare` (`--workspace`
  for several crates), set `SQLX_OFFLINE=true` in CI, and run
  `cargo sqlx prepare --check` there so stale query data fails. A set `DATABASE_URL`
  overrides `.sqlx/` unless `SQLX_OFFLINE=true`.
- Tests: `#[sqlx::test]` gives each test a fresh database with the crate's
  `migrations/` applied (`fixtures(...)` adds test data), so tests run against real
  migrations, not a mock DB.
