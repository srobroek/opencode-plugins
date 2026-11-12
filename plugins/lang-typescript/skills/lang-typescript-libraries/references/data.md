# Data and storage

Choose boundary schemas, wire formats, database access and storage clients without duplicating their semantics.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Validation/serialization | `zod` `4`, native `JSON` | `zod/mini` for bundle pressure; `valibot` `1` for modular schemas; `typebox` `1` for JSON Schema. | Unchecked casts, custom validators for a supported schema concern; JSON numbers for arbitrary-precision identifiers. |
| YAML | `yaml` `2` | `js-yaml` `5` for existing integrations with reviewed schema/options. | Treating configuration parsing as validation; unbounded aliases/documents. |
| TOML | `smol-toml` `1` | Existing runtime/parser when format fidelity is tested. | Invented TOML parsing with regular expressions. |
| CSV | `csv-parse` `7` for server streams | `papaparse` `5` for browser/convenient tabular parsing. | Splitting on commas; ignoring spreadsheet formula injection on export. |
| MessagePack | `@msgpack/msgpack` `3` | JSON when human readability/interoperability wins. | New binary protocols without a measured need or payload bounds. |
| Protobuf | `@bufbuild/protobuf` `2` with generated bindings | Existing generator/runtime for contract compatibility. | Breaking field numbers or handwritten wire codecs. |
| Arrow/Parquet | `apache-arrow` `21`; `parquet-wasm` `0.9` | A validated `@duckdb/node-api` `1.4` release for SQL analytics/file scans. | Treating Arrow as a Parquet reader; loading unbounded datasets into JS objects. |
| Avro | `avsc` `5` when the contract requires Avro | Broker/schema-registry integration already used by the project. | Choosing from download counts alone; schema evolution without compatibility tests. |
| SQL mapping | `drizzle-orm` `0.45` | `kysely` `0.29` for typed SQL; matching `prisma`/`@prisma/client` `7` for generated clients; `@mikro-orm/core` `7` for unit-of-work entities; `typeorm` `1` for existing decorator models. | Prisma `latest` prerelease adoption without migration approval; unnecessary ORM layering. |
| Migrations | `drizzle-kit` `0.31` with Drizzle; the chosen ORM's migration system | Existing reviewed SQL migration runner. | Auto-sync/destructive production schema changes; two migration owners. |
| PostgreSQL | `pg` `8` and a bounded pool | `postgres` `4` for its tagged-template model; Bun native SQL for Bun-only applications. | One connection per query; transaction work escaping its connection. |
| SQLite | `bun:sqlite` on Bun; `better-sqlite3` `13` on Node | Existing runtime-native driver matched to the deployed runtime floor. | Assuming Bun APIs are available on Node or in managed Node Lambda. |
| Pooling | `pg.Pool` through `pg` `8`/`pg-pool` `3`; platform proxy for Lambda pressure | Transaction poolers when prepared statement/session assumptions are compatible. | Multiplying pool size by replica count without database capacity budgeting. |
| Redis/Valkey | `redis` `6` | `ioredis` `6` when queue/client integrations require it; Bun native Redis for a Bun-only, tested feature set. | Assuming every Redis module, cluster, IAM or pub/sub feature is portable between clients. |
| Local cache | `lru-cache` `11` | `keyv` `6` for a common cache interface with an existing adapter. | Unbounded maps; cached authorization or secrets without expiry/invalidation policy. |
| Search | `@opensearch-project/opensearch` `3` for OpenSearch | `@elastic/elasticsearch` `9` for Elasticsearch, matched to server compatibility. | Interchanging server-specific clients; raw signed requests for supported APIs. |
| Lightweight search | `meilisearch` `0.63` for a chosen Meilisearch backend | PostgreSQL search when it already meets requirements. | Deploying another search service without an indexing/operations need. |
| Vectors | Existing PostgreSQL vector extension plus `drizzle-orm` `0.45` or SQL | Existing search/vector service client when scale/features require it. | A new vector database solely to store a small embedding table. |
| Object storage | `@aws-sdk/client-s3` `3`, `@aws-sdk/lib-storage` `3` | Existing storage abstraction when multiple providers are a real requirement. | Handwritten multipart upload, signing or unsafe local path mapping. |
| Data processing | Validated `@duckdb/node-api` `1.4` line for SQL analytics | `arquero` `8` for JS tables; `simple-statistics` `8` for statistics; `nodejs-polars` `0.26` for native DataFrames, whose README lists Node/Bun/Deno. | Automatically treating registry `2.0` prerelease as stable; claiming Node Polars abandoned. |

## Rules

- Decode and validate at the boundary; keep trusted domain data separate from wire DTOs.
- Parameterize SQL, cap query/page sizes, close pools, and test migrations against the real engine.
- Prisma `7` uses ESM, driver adapters, explicit generated output and changed pool
  defaults; review its migration guide rather than carrying forward older pool settings.
- `ioredis` documents best-effort maintenance and recommends `redis` for new work;
  keep it where BullMQ/client compatibility requires it rather than interchanging clients.
- A Node-native driver or add-on needs a Bun integration test; Bun compatibility is not
  proof that every native dependency, pooling mode or tracing hook works.
- For AWS IAM auth, Data API, DynamoDB mapping and service-specific clients, see [aws.md](aws.md).

## Sources

- [Zod](https://zod.dev/v4), [Standard Schema](https://standardschema.dev/), [YAML](https://eemeli.org/yaml/), [CSV](https://csv.js.org/parse/).
- [Drizzle](https://orm.drizzle.team/docs/overview), [Kysely](https://kysely.dev/), [Prisma upgrades](https://www.prisma.io/docs/orm/more/upgrade-guides).
- [Bun SQL](https://bun.sh/docs/runtime/sql), [Bun Redis](https://bun.sh/docs/runtime/redis), [node-redis](https://github.com/redis/node-redis).
- [DuckDB Node API](https://github.com/duckdb/duckdb-node-neo), [Arrow](https://arrow.apache.org/docs/js/), [Drizzle vectors](https://orm.drizzle.team/docs/guides/vector-similarity-search).
- [Registry metadata](https://registry.npmjs.org/).
