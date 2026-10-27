# Persistence: state, transitions, migrations, queries

Read when code stores durable state in a database: repositories, state transitions, migrations, dynamic queries, or persistence tests. Choosing an ORM or driver is in [dependencies.md](dependencies.md); mixed-version compatibility during rollout is in [release.md](release.md).

## The database is the record

**Do:** treat the database as the durable source of truth. Files, caches, search indexes, and exports are projections you can rebuild from it.
**Do not:** keep authoritative state in two places and reconcile them by hand, or let a generated file become the only copy of a fact.

## State transitions are compare-and-set

**Do:** express a transition as one conditional write inside a transaction: `UPDATE jobs SET state = 'running' WHERE id = ? AND state = 'pending'`. When it affects zero rows, re-read to tell not-found from lost-the-race, and return those as different errors.
**Do not:** `SELECT` the state, check it in application code, then `UPDATE` on a bare connection. Another writer can change the row between the two statements.

Bad:

```ts
const job = await db.get("SELECT state FROM jobs WHERE id = ?", id)
if (job.state === "pending") await db.run("UPDATE jobs SET state = 'running' WHERE id = ?", id)
```

Good:

```ts
const { changes } = await db.run(
  "UPDATE jobs SET state = 'running' WHERE id = ? AND state = 'pending'", id)
if (changes === 0) {
  const row = await db.get("SELECT state FROM jobs WHERE id = ?", id)
  return row ? err("conflict", row.state) : err("not_found")
}
```

Where the database offers it, `RETURNING` gives the new row in the same statement. Optimistic version columns (`WHERE version = ?`) are the same pattern for arbitrary edits.

## Migrations are append-only and numbered

**Do:** add numbered migration files and never edit one that has shipped; a fix is a new migration. Run migrations in order at startup or deploy, recorded in the database.
**Do not:** edit or renumber an applied migration. Databases that already ran it will never see the change.

Parallel branches that each take "the next number" collide on merge. Add a CI check that fails on duplicate migration prefixes, or use timestamp prefixes when the tool supports them.

## Dynamic SQL from static fragments

**Do:** build dynamic queries from fixed SQL fragments chosen by code, and bind every value as a parameter. Map user-chosen sort columns or filters through an allow-list to those fragments.
**Do not:** interpolate any value, column, or table name from input into the SQL string.

## Test against a real database

**Do:** run persistence tests on a real database engine with the real migrations applied: in-memory SQLite, or a throwaway Postgres or MySQL container. Each test gets a fresh schema or transaction it rolls back.
**Do not:** mock the database driver. A mock cannot catch constraint violations, transaction semantics, migration errors, or SQL typos.

**Exception:** keep pure domain logic out of the database so it tests without one; the real-database rule applies to the code that talks to it.
