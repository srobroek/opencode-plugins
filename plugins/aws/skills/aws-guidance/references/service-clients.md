# AWS service clients: library or raw SDK

Read before you write code that talks to an AWS service. Checked 2026-11-12. Use the AWS SDK for control-plane calls (create, configure, administer) and for simple, exact requests. Use a higher-level library when it removes a concrete burden: mapping, pagination, multipart transfers, leasing and checkpoints, caching, credential refresh, or replay. Versions and per-language detail are in `lang-<language>-libraries`, `references/aws.md`.

| Service | Python | TypeScript | Go | Rust | Avoid |
| --- | --- | --- | --- | --- | --- |
| DynamoDB | PynamoDB 6 for model-oriented code (transactions, `VersionAttribute` locking); boto3 client for exact requests | ElectroDB 3 for typed single-table entities; `dynamodb-toolbox` 2 for a lighter builder; `@aws-sdk/lib-dynamodb` for plain CRUD | SDK with `feature/dynamodb/attributevalue` and `expression`; `guregu/dynamo/v2` for fluent queries | `serde_dynamo` 4 for conversion; `modyne` for single-table modeling | OneTable (archived, unmaintained); new features through the boto3 resource layer (frozen) |
| Valkey, Redis, ElastiCache, MemoryDB | Valkey GLIDE 2 (async, cluster-aware, built-in IAM); `valkey` or `redis` for existing code | `@valkey/valkey-glide` 2 where native modules deploy; `redis` (node-redis) 6 otherwise | GLIDE Go 2 or `valkey-go`; `rueidis` for pipelining and server-assisted caching | `redis` 1 | Treating GLIDE's TTL-only client cache as invalidated; the AWS SDK for data commands |
| S3 | boto3 `upload_file`/`download_file` with `TransferConfig`; `obstore` or `s3fs` for object-store APIs | `@aws-sdk/lib-storage` `Upload`; `@aws-sdk/s3-request-presigner` | `feature/s3/transfermanager` (the `feature/s3/manager` uploader is deprecated) | `aws-sdk-s3`; `object_store` or `opendal` for portable code | Hand-written multipart; proxying downloads that a presigned URL can serve |
| SQS, SNS, EventBridge | Powertools Batch in Lambda; boto3 elsewhere | Powertools Batch in Lambda; `sqs-consumer` and `sqs-producer` for long-running workers | SDK with an explicit polling loop (cancellation, visibility renewal, delete, backoff) | Same as Go | A polling library inside an event-source-mapped Lambda; Celery only to poll business events |
| Secrets Manager, SSM, AppConfig | Powertools Parameters; `aws-secretsmanager-caching` for Secrets-only code | Powertools Parameters | `aws-secretsmanager-caching-go` where its SDK version fits; the Parameters and Secrets extension | The Lambda extension; the AppConfig agent | Fetching an unchanged secret every invocation |
| Cognito tokens | `PyJWT` with its JWKS client and explicit issuer, audience and `token_use` checks | `aws-jwt-verify` 5 | `lestrrat-go/jwx/v3` with a JWKS cache | `jsonwebtoken` with a cached JWKS fetch | Signature checks without claim checks; the whole Amplify stack for one bearer check |
| RDS, Aurora, Aurora DSQL | `aws-advanced-python-wrapper` 3 for failover and IAM; `aurora-dsql-python-connector` for DSQL | `aws-advanced-nodejs-wrapper` 3; Drizzle or `kysely-data-api` for the Data API; `@aws/aurora-dsql-node-postgres-connector` | `aws-advanced-go-wrapper`; the DSQL `pgx` connector | `aurora-dsql-sqlx-connector` for DSQL | A topology wrapper when nothing needs failover; treating DSQL as plain PostgreSQL |
| OpenSearch Service and Serverless | `opensearch-py` 3 with its AWS SigV4 auth | `@opensearch-project/opensearch` 3 with `AwsSigv4Signer` | `opensearch-go/v4` with its signer | `opensearch` with the `aws-auth` feature | The wrong signing service (`es` for domains, `aoss` for Serverless); frozen temporary credentials |
| Kinesis | `amazon-kclpy` 3 (KCL 3 through the Java MultiLangDaemon) | `aws-kcl` 3 | A Lambda event source, or Java KCL 3 | Same as Go | KCL 1.x (support ended 2026-01-30) |
| MSK with IAM | A Kafka client plus `aws-msk-iam-sasl-signer-python` | A Kafka client plus `aws-msk-iam-sasl-signer-js` | A Kafka client plus `aws-msk-iam-sasl-signer-go` | A reviewed signer only (the crate is community-owned) | Using the AWS SDK for records; a static token without refresh |
| Bedrock | boto3 `bedrock-runtime` Converse for direct calls; `anthropic[bedrock]` for Claude features; Strands Agents for an agent loop | `@ai-sdk/amazon-bedrock` for a unified streaming API; `@anthropic-ai/bedrock-sdk`; Strands for agents | The runtime SDK Converse API | The runtime SDK | An agent framework for a single inference call |
| CloudWatch metrics | Powertools Metrics in Lambda; `aws-embedded-metrics` elsewhere; OTel for cross-service telemetry | Same as Python | OTel through the Collector | Same as Go | High-cardinality dimensions |
| Lambda durable functions | `aws-durable-execution-sdk-python` | `@aws/durable-execution-sdk-js` | `aws-durable-execution-sdk-go` | No official SDK | Side effects that are not replay-safe |

Rules:

1. Prefer an official SDK helper before a third-party framework.
2. A single-table library must fit the access patterns, not just offer models.
3. Require documented conditional-write, retry and pagination semantics from any data library.
4. IAM support means credential refresh, reconnection and expiry handling, not only signing.
5. Cache only with acceptable staleness and verified invalidation.
6. Test wrappers against the real service as well as emulators, and keep a raw-SDK escape hatch.

## Sources

- boto3 resources (no new features): https://boto3.amazonaws.com/v1/documentation/api/latest/guide/resources.html
- Valkey GLIDE: https://github.com/valkey-io/valkey-glide
- GLIDE client-side caching: https://glide.valkey.io/concepts/client-features/client-side-caching/
- ElastiCache IAM auth: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html
- Aurora DSQL connectors: https://github.com/awslabs/aurora-dsql-connectors
- OpenSearch Serverless clients: https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-clients.html
- KCL: https://docs.aws.amazon.com/streams/latest/dev/kcl.html
- MSK IAM clients: https://docs.aws.amazon.com/msk/latest/developerguide/configure-clients-for-iam-access-control.html
- Durable execution SDKs: https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk.html
