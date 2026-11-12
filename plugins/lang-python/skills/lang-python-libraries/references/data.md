# Python data

Choose boundary models, data formats, persistence clients and analytical tools without replacing the project's existing data stack.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Boundary models | `pydantic` `2` | `msgspec` `0.22` for measured encoding throughput; `attrs` `26` plus `cattrs` `26` for domain models independent of validation | Assuming annotations or `dataclasses` validate input; permissive coercion on security-sensitive fields |
| Internal records | `dataclasses` | `attrs` `26` for richer record behavior | Coupling every internal domain type to a boundary framework |
| JSON | `json`; existing model library's encoder | `orjson` `3` when profiling justifies it | Orjson returns bytes and is not an exactly interchangeable stdlib implementation |
| YAML | `PyYAML` `6` with `safe_load` | `ruamel.yaml` `0.19` for YAML 1.2 and comment-preserving edits | Unsafe loaders; removed module-level ruamel APIs |
| TOML | `tomllib` on Python `3.11` or later | `tomli-w` `1` for writing; `tomlkit` `0.15` to retain comments/formatting | Lossy rewriting of user configuration |
| CSV | `csv` | `polars` `2` or `pyarrow` `26` for analytical ingestion | Splitting on commas; undefined encoding/dialect; spreadsheet formula injection |
| MessagePack | `msgpack` `1` | JSON when inspectability/interoperability matter | Binary encoding is not validation; bound allocation/input sizes |
| Protobuf | `protobuf` `7` generated bindings with `grpcio-tools`/`grpcio` `1` | `betterproto2` `0.10` after compatibility tests | Unpinned generator/runtime families; check edition support across all plugins |
| Arrow/Parquet | `pyarrow` `26` | Existing compatible DataFrame integration | Native-extension upgrades without wheel/ABI tests |
| Avro | `avro` `1` | `fastavro` `1` for measured performance with accepted maintenance risk | Fastavro's maintenance notice warns that fixes may be significantly delayed |
| Relational ORM/query builder | `SQLAlchemy` `2` | Django ORM within `Django` `6`; `sqlmodel` `0.0` for simple Pydantic/ORM overlap; `tortoise-orm` `1` or `piccolo` `1` for an accepted async-first ecosystem | Exposing persistence models directly as writable API schemas |
| PostgreSQL | `psycopg` `3` | `asyncpg` `0.32` for PostgreSQL-specific async integration | Blocking DB clients on the event loop; SQLite tests as proof of PostgreSQL semantics |
| Embedded DB | `sqlite3` | Server DB for transactional multi-service access | Treating file-backed concurrency as a drop-in server DB |
| Migrations | `Alembic` `1` with SQLAlchemy | Django migrations in Django applications | Unreviewed autogeneration; rewriting applied migrations |
| Pools and transactions | SQLAlchemy engine pool or driver-managed pool | `psycopg_pool` `3` for direct-driver services | Multiple competing pools; unbounded connections; one `AsyncSession` shared by concurrent tasks |
| Redis/Valkey | `redis` `8`, including asyncio API | `valkey-glide` `2` for async AWS clusters/IAM automation; `valkey` `6` for Valkey-specific ownership; `cashews` `7` for higher-level caching; `aiocache` `0.12` for existing integrations | New standalone `aioredis`; no TTL/invalidation; GLIDE cache features vary by binding |
| Local memoization | `functools.cache`/`lru_cache` | `cachetools` `8` for TTL/custom eviction | Caching coroutine objects; assuming cachetools collections are thread-safe |
| OpenSearch/Elasticsearch | Engine-matched `opensearch-py` `3` or `elasticsearch` `9` | Supported older client major for the deployed engine | Interchanging engine clients or blindly taking newest major |
| Meilisearch | `meilisearch` `0.43` | Existing engine-native client | Assuming Elasticsearch-equivalent features |
| Vectors | `pgvector` `0.5` with PostgreSQL | Dedicated vector service when operational requirements justify it | Python adapter does not install the DB extension |
| S3/object operations | `boto3` `1` | `fsspec`/`s3fs` `2026` for filesystem consumers; `obstore` `0.12` for typed sync/async object operations | Filesystem abstraction for one SDK call; assuming POSIX atomic rename semantics |
| DataFrames | `polars` `2` | `pandas` `3` for its ecosystem, notebooks or index semantics | Gratuitous pandas migration or universal performance claims |
| Analytical SQL | `duckdb` `2` | Polars expressions for existing pipelines; server DB for OLTP | Embedded analytics as a general transactional server |
| Numerical arrays | `numpy` `2` | DataFrames for table-oriented transformations | Unverified native-extension compatibility across upgrades |
| DataFrame validation | `pandera` `0.36` | Explicit checks for tiny schemas | Assuming pandas and Polars backends behave identically |

## Rules

- Keep validation, persistence and public response schemas separate where writable fields or lifecycle differ.
- Own a transaction/session per unit of work; keep transactions short. Use bound parameters and database constraints for invariants.
- Load `lang-python-persistence` for SQLAlchemy/Alembic practices and `lang-python-testing` for real-backend tests.
- Match client and cluster majors. Measure throughput/memory with representative inputs before changing encoders or analytical engines.

## Sources

- [Pydantic](https://docs.pydantic.dev/), [msgspec benchmarks](https://msgspec.dev/benchmarks.html), [orjson](https://github.com/ijl/orjson)
- [PyYAML](https://pyyaml.org/wiki/PyYAMLDocumentation), [ruamel changes](https://yaml.dev/doc/ruamel.yaml/), [TOML](https://docs.python.org/3/library/tomllib.html)
- [Arrow](https://arrow.apache.org/docs/python/), [fastavro maintenance](https://github.com/fastavro/fastavro)
- [SQLAlchemy async sessions](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html), [psycopg](https://www.psycopg.org/psycopg3/docs/)
- [Pool registry](https://pypi.org/project/psycopg-pool/), [Protobuf registry](https://pypi.org/project/protobuf/), [GLIDE](https://github.com/valkey-io/valkey-glide)
- [Redis client](https://github.com/redis/redis-py), [Valkey client](https://github.com/valkey-io/valkey-py), [cachetools](https://cachetools.readthedocs.io/)
- [OpenSearch compatibility](https://github.com/opensearch-project/opensearch-py), [pgvector](https://github.com/pgvector/pgvector-python)
- [fsspec](https://filesystem-spec.readthedocs.io/), [obstore](https://developmentseed.org/obstore/)
- [Polars](https://docs.pola.rs/), [DuckDB](https://duckdb.org/docs/stable/clients/python/overview), [Pandera backends](https://pandera.readthedocs.io/en/stable/supported_libraries.html)
- [Package version registry](https://pypi.org/)
