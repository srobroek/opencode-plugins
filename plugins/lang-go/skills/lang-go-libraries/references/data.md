# Go data and persistence

Choose codecs and clients for the actual format, database and workload rather than a uniform abstraction.

Checked 2026-11-12. Standard-library entries use Go `1.27`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Small boundary validation | Explicit checks; standard library is sufficient | `github.com/go-playground/validator/v10` `10` for DTO tags | Tags standing in for business invariants or authorization. |
| JSON | `encoding/json` for compatible contracts; standard library is sufficient | `encoding/json/v2` for new Go `1.27` contracts; `github.com/goccy/go-json` `0.12` or `github.com/bytedance/sonic` `1` only after profiling/platform checks | Untested semantic migrations; v2 rejects duplicate names and invalid UTF-8 by default. |
| YAML | `go.yaml.in/yaml/v3` `3` | `github.com/goccy/go-yaml` `1` for parser/error tooling | New dependencies on `gopkg.in/yaml.v3`: original repository archived. |
| TOML | `github.com/pelletier/go-toml/v2` `2` | `github.com/BurntSushi/toml` `1` for existing conventions | Custom parsers or unsupported inactivity claims. |
| CSV | `encoding/csv`; standard library is sufficient | Domain schema mapping over the codec | Comma splitting; unchecked spreadsheet formula injection on export. |
| MessagePack | JSON unless binary protocol is required | `github.com/vmihailenco/msgpack/v5` `5` for MessagePack contracts | Binary encoding without interoperability or size requirements. |
| Protobuf | `google.golang.org/protobuf` `1` for Protobuf contracts | JSON for ordinary human-facing interfaces | Hand-marshaling generated messages. |
| Avro | JSON/Protobuf unless an Avro contract exists | `github.com/hamba/avro/v2` `2` for Avro encoding; registry integration verified separately | Assuming a codec supplies schema-registry discovery and evolution policy. |
| Parquet | `github.com/parquet-go/parquet-go` `0.32` for Parquet files | `github.com/apache/arrow-go/v18` `18` for Arrow arrays/IPC | Treating columnar files and in-memory Arrow as interchangeable. |
| PostgreSQL | `github.com/jackc/pgx/v5` `5` plus `github.com/sqlc-dev/sqlc` `1` | `database/sql` for portable database APIs; standard library suffices for pooling over a selected driver | Connection-per-query, string-built SQL or redundant pools. |
| Query builders and ORMs | SQL and generated queries first | `gorm.io/gorm` `1` for runtime ORM; `entgo.io/ent` `0` for generated entities; `github.com/uptrace/bun` `1` for SQL-oriented ORM | ORM adoption without needed capabilities; hidden N+1 and transaction semantics. |
| Struct scanning | Driver scanning or generated SQL | `github.com/jmoiron/sqlx` `1` for existing struct-scanning code | Calling sqlx archived: it is not; old release/activity requires responsiveness checks. |
| Migrations | `github.com/pressly/goose/v3` `3` | `github.com/golang-migrate/migrate/v4` `4` for its drivers; `ariga.io/atlas` `1` for declarative planning | Production ORM auto-migration; ignoring Atlas edition/license boundaries. |
| Pooling | `github.com/jackc/pgx/v5/pgxpool` `5` or `database/sql` | Direct connections for explicitly constrained lifecycle/concurrency | Unbounded pool counts across replicas; pool over another pool. |
| Valkey/Redis | `github.com/valkey-io/valkey-go` `1`; `github.com/redis/go-redis/v9` `9` for Redis | `github.com/redis/rueidis` `1` for its API/cache model; GLIDE `2` for cross-language AWS behavior, detailed in `aws.md` | Claims that only rueidis has automatic pipelining/client caching; current go-redis has both. |
| In-process cache | Map plus mutex or `sync.Map`; standard library suffices without eviction | `github.com/maypok86/otter/v2` `2` for eviction; `github.com/dgraph-io/ristretto/v2` `2` for cost-based admission | Approximate cache as authoritative state; Ristretto can drop sets. |
| Search | SQL search until inadequate | `github.com/opensearch-project/opensearch-go/v4` `4`, `github.com/elastic/go-elasticsearch/v9` `9` or `/v8` `8` matched to product/server | Assuming Elasticsearch and OpenSearch clients are interchangeable. |
| Other search | Selected server's official client | `github.com/meilisearch/meilisearch-go` `0.37`; `github.com/blevesearch/bleve/v2` `2` for embedded indexing | Adding a search server before demonstrating the SQL gap. |
| Vectors | `github.com/pgvector/pgvector-go` `0.4` with PostgreSQL pgvector | Dedicated vector service for measured scale/features | Confusing the Go adapter with the database extension. |
| Object storage | AWS SDK v2 S3 client for simple objects | `github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager` `0.5` for multipart/transfers; `gocloud.dev/blob` `0.48` for genuine provider portability | New use of deprecated S3 manager uploader/downloader APIs. |
| Embedded analytics | Database SQL for ordinary service queries | `github.com/duckdb/duckdb-go/v2` `2` for embedded analytics | Assuming DuckDB is pure-Go or simple static cross-compilation; plan CGO. |
| Numerical processing | `math`; standard library suffices for elementary operations | `gonum.org/v1/gonum` `0.17` for numerical algorithms | Inferring module major `1` from Gonum's hostname path; unvalidated custom algorithms. |

## Rules

- Bound decode size, depth, record count and decompression. Validate external data before domain construction.
- Keep transactions and conditional writes explicit. Test concurrency, rollback, pagination and pool exhaustion against real infrastructure.
- Pin pre-stable modules and review wire/schema changes on upgrades. Preserve a raw-driver/SDK escape hatch.
- Choose cache TTL and invalidation against acceptable staleness, not only benchmark throughput.

## Sources

- [JSON changes](https://go.dev/doc/go1.27), [validator](https://pkg.go.dev/github.com/go-playground/validator/v10), [YAML](https://pkg.go.dev/go.yaml.in/yaml/v3), [original YAML archive](https://github.com/go-yaml/yaml), [TOML](https://pkg.go.dev/github.com/pelletier/go-toml/v2), [CSV](https://pkg.go.dev/encoding/csv).
- [MessagePack](https://pkg.go.dev/github.com/vmihailenco/msgpack/v5), [Protobuf](https://pkg.go.dev/google.golang.org/protobuf), [Avro](https://pkg.go.dev/github.com/hamba/avro/v2), [Parquet](https://pkg.go.dev/github.com/parquet-go/parquet-go), [Arrow](https://pkg.go.dev/github.com/apache/arrow-go/v18).
- [pgx](https://pkg.go.dev/github.com/jackc/pgx/v5), [sqlc](https://pkg.go.dev/github.com/sqlc-dev/sqlc), [standard SQL](https://pkg.go.dev/database/sql), [GORM](https://pkg.go.dev/gorm.io/gorm), [ent](https://pkg.go.dev/entgo.io/ent), [Bun](https://pkg.go.dev/github.com/uptrace/bun), [Goose](https://pkg.go.dev/github.com/pressly/goose/v3), [migrate](https://pkg.go.dev/github.com/golang-migrate/migrate/v4), [Atlas](https://atlasgo.io/).
- [Valkey](https://pkg.go.dev/github.com/valkey-io/valkey-go), [go-redis](https://pkg.go.dev/github.com/redis/go-redis/v9), [rueidis](https://pkg.go.dev/github.com/redis/rueidis), [Otter](https://pkg.go.dev/github.com/maypok86/otter/v2), [Ristretto](https://pkg.go.dev/github.com/dgraph-io/ristretto/v2).
- [OpenSearch](https://pkg.go.dev/github.com/opensearch-project/opensearch-go/v4), [Elasticsearch](https://pkg.go.dev/github.com/elastic/go-elasticsearch/v9), [Meilisearch](https://pkg.go.dev/github.com/meilisearch/meilisearch-go), [Bleve](https://pkg.go.dev/github.com/blevesearch/bleve/v2), [pgvector](https://pkg.go.dev/github.com/pgvector/pgvector-go).
- [S3 transfer manager](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager), [Go Cloud](https://pkg.go.dev/gocloud.dev/blob), [DuckDB build](https://github.com/duckdb/duckdb-go#cross-compilation), [Gonum](https://pkg.go.dev/gonum.org/v1/gonum).
