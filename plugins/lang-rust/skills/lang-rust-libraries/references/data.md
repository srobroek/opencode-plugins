# Data and persistence

Choose formats and persistence crates by wire compatibility, query needs and tested deployment constraints.

Checked 2026-11-12.

## Serialization comparison

| Option | Fit | Selection |
| --- | --- | --- |
| `serde_json` `1` with `serde` `1` | Broad integrations and ordinary JSON | Default until parsing cost is material. |
| `simd-json` `0.19` | Serde-compatible SIMD parsing | Measure inputs, buffer ownership and deployment CPU; substantial unsafe implementation. |
| `sonic-rs` `0.5` | Serde, lazy extraction and custom DOM | Measure production inputs; author's older Xeon benchmark is not independent current-version evidence. |
| `postcard` `1.1` | Compact Serde/no-standard-library messages | Constrained internal binary protocols. |
| `rkyv` `0.8` | Zero-copy archives | Validate untrusted archives and design layout/version compatibility. |
| `borsh` `1.8` | Canonical binary representation | Protocol/hash ecosystem demands it, not arbitrary JSON replacement. |

These formats are not wire-interchangeable. `bincode` is unmaintained; its latest major intentionally fails compilation. Do not add it or blindly upgrade existing `2` consumers to `3`.

## Database comparison

| Option | Fit and ergonomics | Selection |
| --- | --- | --- |
| `sqlx` `0.9` | Async explicit SQL, checked macros, pools/migrations | Default SQL-first service; MSRV `1.94`, offline metadata/schema CI required. |
| `diesel` `2.3`, `diesel-async` `0.9` | Typed composable DSL; async PostgreSQL/MySQL, SQLite sync wrapper | DSL and compile-time composition justify learning/build cost. |
| `sea-orm` `2` | Entities, relations, loaders and persistence helpers | CRUD/relationship productivity; inspect generated SQL. |
| `tokio-postgres` `0.7` | PostgreSQL-specific control and pipelining | Explicit connection driving, TLS and pool setup fit the task. |

No equivalent-query benchmark was verified. Pipelining overlaps communication, not parallel execution on the server. Use `lang-rust-persistence` for SQLx migration, offline metadata and compare-and-set details.

## Picks

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Validation/schema | `validator` `0.21`, `schemars` `1.2` | `garde` `0.23` for contextual/nested/enum validation | Schemas or email syntax checks mistaken for domain invariants. |
| YAML | `serde-saphyr` `2.1`, provisional choice | Only after required YAML semantics and parser budgets pass fixtures | Both `serde_yaml` `0.9` and `serde_yml` `0.0` are deprecated; latter is not the default replacement. |
| TOML | `toml` `1.2` | `toml_edit` `0.25` to preserve user formatting | Lossy rewrites of user-authored settings. |
| CSV | `csv` `1.4` | Streaming/chunked consumption using the same crate | Loading unbounded exports or assuming all rows are valid. |
| MessagePack/CBOR | `rmp-serde` `1.3`, `ciborium` `0.2` | Existing protocol chooses a different encoding | Treating format choice as schema evolution policy. |
| Protobuf | `prost` `0.14` | `buffa` `0.9` for supported editions/borrowed views | Assuming every generator supports every edition. |
| Arrow/Parquet | `arrow` `60`, `parquet` `60` | Existing analytics stack pins a compatible line | Old `arrow-data` patches affected by RunEndEncoded unsoundness; audit patch floors. |
| Avro | No versioned Rust default established | Existing schema-registry protocol requires it; evaluate and approve a client | Inventing a supported crate/version or replacing schemas with ad hoc binary data. |
| Pools/migrations | `sqlx` `0.9` built-ins | `deadpool-postgres` `0.14` for PostgreSQL, `deadpool` `0.13` or `bb8` `0.9` for other drivers; `refinery` `0.10` independent migrations | Duplicate pools, sync queries on async workers, interpolated SQL. |
| Redis/Valkey | `redis` `1.8` async client | `fred` `10.1` for pipelining, replica routing and richer connection APIs | Blocking clients in async handlers; ignoring cluster/TLS/reconnect semantics. |
| Local caches | `moka` `0.12` | Standard map when cache policy is unnecessary | Unbounded caches; local cache used as durable shared state. |
| Object storage | `object_store` `0.14` | `opendal` `0.59` for broader backends; `aws-sdk-s3` `1` for full AWS operations | An abstraction hiding required multipart/signing/consistency features. |
| Search | `tantivy` `0.27` for embedded indexing | `meilisearch-sdk` `0.33` or `opensearch` `2.4` for those servers | Treating an embedded engine as a hosted-service client. |
| Vectors | `pgvector` `0.4` when PostgreSQL is already chosen | Existing provider's reviewed client for operational requirements | Selecting a vector database before defining filters, scale and recall tests. |
| DataFrames | `polars` `0.55` | `datafusion` `55` for extensible SQL; `duckdb` `1.20000` embedded SQL; `ndarray` `0.17` numerical arrays | Large analytics/native dependencies for simple iterator transformations. |

## Rules

- Specify payload/schema versions independently of crate versions; test round-trips and compatibility, including unknown fields.
- Bound parser depth, decompression, rows and allocations. Parameterize SQL, size pools deliberately, and test transactions against the real database.
- Pin feature sets and check runtime/TLS/MSRV combinations; latest registry metadata does not certify the lockfile.

## Sources

- [Serde JSON](https://crates.io/crates/serde_json), [SIMD JSON](https://docs.rs/simd-json/latest/simd_json/), [Sonic](https://github.com/cloudwego/sonic-rs), [Bincode status](https://docs.rs/bincode/latest/bincode/).
- [SQLx](https://docs.rs/sqlx/latest/sqlx/), [Diesel async](https://docs.rs/diesel-async/latest/diesel_async/), [SeaORM](https://docs.rs/sea-orm/latest/sea_orm/), [PostgreSQL driver](https://docs.rs/tokio-postgres/latest/tokio_postgres/).
- [YAML replacement](https://docs.rs/serde-saphyr/latest/serde_saphyr/), [deprecated YAML](https://crates.io/crates/serde_yml), [Arrow advisory](https://rustsec.org/advisories/RUSTSEC-2026-0442.html).
- [Redis](https://docs.rs/redis/latest/redis/), [Object store](https://docs.rs/object_store/latest/object_store/), [Crate registry](https://crates.io/).
