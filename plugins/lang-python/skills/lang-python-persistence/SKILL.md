---
name: lang-python-persistence
description: Use for Python SQLAlchemy 2.x sessions and Alembic migrations (autogenerate review, single head, rowcount CAS, test DBs).
metadata:
  opencode/autoinvoke: false
---

# Python Persistence (SQLAlchemy and Alembic)

Sources: [SQLAlchemy 2.x session basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html), [UPDATE and rowcount](https://docs.sqlalchemy.org/en/20/tutorial/data_update.html), [SQLite dialect](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html), [Alembic autogenerate](https://alembic.sqlalchemy.org/en/latest/autogenerate.html), [branches](https://alembic.sqlalchemy.org/en/latest/branches.html), [offline mode](https://alembic.sqlalchemy.org/en/latest/offline.html), [cookbook](https://alembic.sqlalchemy.org/en/latest/cookbook.html). Examples run with SQLAlchemy 2.1 and Alembic 1.20.

The language-neutral rules (database is the record, compare-and-set transitions,
append-only migrations, real-database tests) are the `quality-code-design` skill's
`persistence.md` reference. This skill is how to do them in SQLAlchemy and Alembic.

## Sessions: one per unit of work

```python
SessionLocal = sessionmaker(engine, expire_on_commit=False)

def handle(request: Request) -> Response:
    with SessionLocal.begin() as session:     # commits on success, rolls back on exception
        ...
```

- One session per request, job or command; never a module-global session, and never
  one shared across threads or tasks.
- `expire_on_commit=False` keeps loaded attributes readable after commit, so
  returning a model from the unit of work does not trigger a lazy reload on a closed
  session.
- Async: `async_sessionmaker` and `AsyncSession`. Lazy loading raises there; load
  relationships eagerly (`selectinload`) or mark them `lazy="raise"` so a missing
  eager load fails in tests.

## State transitions: one conditional UPDATE, then `rowcount`

```python
result = session.execute(
    update(Job).where(Job.id == job_id, Job.state == "pending").values(state="running")
)
if result.rowcount == 0:
    state = session.scalar(select(Job.state).where(Job.id == job_id))
    raise NotFound(job_id) if state is None else Conflict(job_id, state)
```

`rowcount` is the number of rows the `WHERE` matched. It may be `-1` (unknown) with
`RETURNING` or `executemany` on some drivers; in that case use
`.returning(Job.id)` and check whether a row came back. For edits of whole objects, a
version column (`__mapper_args__ = {"version_id_col": version}`) makes a concurrent
flush raise `StaleDataError` instead of silently overwriting.

## Alembic autogenerate: review before commit

```sh
alembic revision --autogenerate -m "add invoice due date"
```

Autogenerate compares models with the database and drafts a migration. Read it line by
line:

- A renamed table or column comes out as drop plus add, which deletes the data.
  Rewrite it as `op.rename_table` or `op.alter_column(..., new_column_name=...)`.
- Unnamed constraints cannot be compared or dropped reliably. Set a
  `MetaData(naming_convention={...})` on the declarative base once (`ix`, `uq`, `ck`,
  `fk`, `pk` keys, as in the Alembic docs) before the first migration.
- Server defaults are not compared unless `compare_server_default=True`; `Enum` value
  changes are not detected on most backends. Add those operations by hand.
- A new `NOT NULL` column on a populated table needs a `server_default` or three
  steps: add nullable, backfill, then alter to `NOT NULL`.
- Data migrations use `op.execute` / `op.get_bind()` with SQL written for the schema
  at that revision, never the current ORM models, which will change later.
- SQLite cannot `ALTER` most things: configure `render_as_batch=True` in `env.py` so
  Alembic copies the table instead.
- Write a `downgrade()` that works, or one that raises with a reason; never leave a
  silent `pass`.

In OpenCode the safety plugin refuses edits to a revision in `versions/` that has
already shipped; write a new revision instead.

## CI checks

```sh
test "$(alembic heads | wc -l)" -eq 1     # one head: parallel branches each added a revision
alembic upgrade head                      # on a fresh database
alembic check                             # fails when models changed without a migration (1.9+)
alembic upgrade head --sql > upgrade.sql  # offline SQL for review or a DBA hand-off
```

Two heads after a merge: `alembic merge heads -m "merge <a> and <b>"` creates a
revision with both parents. Do not rewrite either branch's `down_revision`.

## Tests on a real database with the real migrations

```python
@pytest.fixture
def session() -> Iterator[Session]:
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    event.listen(engine, "connect", lambda conn, _: conn.execute("PRAGMA foreign_keys=ON"))
    with engine.begin() as conn:
        cfg = Config("alembic.ini")
        cfg.attributes["connection"] = conn       # env.py must use it (below)
        command.upgrade(cfg, "head")
    with Session(engine) as session:
        yield session
    engine.dispose()
```

```python
# migrations/env.py, at the top of run_migrations_online()
connection = config.attributes.get("connection")
if connection is not None:
    context.configure(connection=connection, target_metadata=target_metadata,
                      render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()
    return
```

- `StaticPool` keeps one connection, so every session sees the same in-memory
  database. SQLite leaves foreign keys off unless each connection runs the pragma.
- Running the migrations, not `Base.metadata.create_all()`, tests the schema you ship
  and catches a broken revision before deploy.
- In-memory SQLite is fast but not Postgres: types, locking, `ON CONFLICT` and JSON
  behave differently. When production is Postgres or MySQL, run the persistence tests
  against that engine in a container (for example testcontainers) and keep SQLite for
  code that is portable by design.
