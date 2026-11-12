# Go AWS and Lambda

Use official SDK helpers unless a maintained library removes markedly more work (see `aws-guidance`'s `service-clients.md`), with thin Lambda adapters and manual OpenTelemetry.

Checked 2026-11-12. Standard-library entries use Go `1.27`; use `aws-guidance` for deployment and service constraints.

## Runtime and middleware

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| AWS SDK | `github.com/aws/aws-sdk-go-v2` `1` root and independently pinned service modules | Higher-level helpers below for a named mapping, transfer, caching or replay burden | Old SDK generation or assuming all v2 product modules share the root version. |
| Lambda runtime | `github.com/aws/aws-lambda-go` `1`, `provided.al2023` | Existing HTTP server plus `aws-lambda-web-adapter` `1` | Deprecated `go1.x` or `provided.al2`; assuming OS-only runtimes have SnapStart. |
| Single-purpose event | Typed `events`, `lambdacontext` and function wrappers from Lambda runtime `1` | Reviewed shared wrapper for repeated lifecycle concerns | Unchecked envelopes and request-specific mutable globals. |
| Single HTTP endpoint | The same `net/http` handler through `github.com/awslabs/aws-lambda-go-api-proxy/httpadapter` `0.16` with Lambda runtime `1` | Web Adapter `1` when reusing a listening server | A separate Lambda framework or route implementation for the same HTTP surface. |
| Multi-route/container reuse | The same `net/http` handler/middleware through Web Adapter `1` | The API Proxy `httpadapter` `0.16` for an event-handler deployment after event-envelope compatibility tests | Two routers/body parsers; assuming non-HTTP forwarding implements partial-batch acknowledgment. |
| Lambda tracing | OTel SDK `1`, contrib `otellambda` `0.72`, collector extension pinned in IaC | Collector's X-Ray exporter for existing storage requirements | Assuming Go has Python-style auto-instrumentation layers; new X-Ray SDK dependency. |
| Local testing | `testing`, synthetic typed events and `httptest`; standard library is sufficient for adapters | SAM local invocation, DynamoDB Local or LocalStack for selected integration behavior | Emulator success presented as proof of IAM, event-source or telemetry correctness. |

Official Powertools has no Go distribution. Do not label community ports AWS-supported. These substitutes cover the same concerns without inventing a replacement framework.

## Powertools substitutes

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Logger | `log/slog` JSON with invocation-scoped request ID, cold-start and active trace/span attributes | Existing structured logger | Payloads/secrets in logs; ordinary slog does not add trace correlation automatically. |
| Metrics | OTel metrics `1` and collector when already standardized | `prozz/aws-embedded-metrics-golang` (last release 2021-09-30; review ownership and pin) for CloudWatch business metrics without a Collector | Casual handwritten EMF wire formats or duplicate metric publication. |
| Parser/validation | Lambda runtime `1` event types, `encoding/json` and explicit checks | Validator `10` for DTO tags | Recreating AWS event schemas or treating decoding as authorization. |
| Batch | Lambda runtime `1` partial-response types plus a reviewed shared processor | Event-specific adapter when response semantics differ | Whole-batch retry for isolated failures; silently acknowledging failed records. |
| Idempotency | SDK v2 DynamoDB conditional writes, in-progress/completed state and TTL | Downstream stable operation token | Handler-local check-then-write deduplication or invocation IDs as keys. |
| Parameters | SDK v2 with bounded TTL cache or approved Lambda extension | AppConfig Agent for local cached polling/token management | Secrets fetch for every record, unbounded caches or stale credentials. |
| Feature flags | `github.com/open-feature/go-sdk` `1`; simple runtime toggles: contrib `providers/aws-ssm` `1.0`, no cache, `GetParameter` per evaluation, shared 40 TPS default; evaluate once per request; object flags return default | Kill switches/rollout: third-party `github.com/Arthur1/openfeature-provider-go-aws-appconfig` `0.4`, Agent only, boolean flags, review dependency; deploy-time flags: contrib `providers/flagd` `0.8` over flags.yaml | Ask before writing a missing provider; no silent Agent wrapper fallback; see `aws-guidance` and `quality-code-design`'s `feature-flags.md`. |
| Data masking | Data minimization, allowlisted structured attributes and reviewed redaction | Approved encryption/masking component for a defined requirement | Homemade cryptographic primitives. |
| Routing | Standard `net/http` middleware for HTTP; typed dispatch for events | Web Adapter `1` for server reuse | HTTP middleware presented as a queue batch-processing engine. |

## Service clients versus raw SDK

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| DynamoDB | SDK `feature/dynamodb/attributevalue` `1` and `expression` `1` | `github.com/guregu/dynamo/v2` `2` for fluent queries and struct marshaling | Assuming a model library designs keys, locking and cursor semantics; transaction-conflict retries are not automatic in dynamo v2. |
| Valkey/ElastiCache | `github.com/valkey-io/valkey-go` `1` for Go protocol API | `github.com/valkey-io/valkey-glide/go/v2` `2` for cross-language behavior/IAM automation; rueidis `1` or go-redis `9` for existing ecosystems | AWS management SDK for data commands; throughput-only comparisons. |
| Cache IAM and invalidation | Renewable credentials and cluster-aware protocol client | GLIDE `2` built-in IAM behavior where binding/deployment compatibility is verified | Static tokens; GLIDE caching defaults to TTL-only and its invalidation behavior varies by binding. |
| S3 | SDK v2 S3 client/`PresignClient` for simple objects | `feature/s3/transfermanager` `0.5` for automatic multipart, directories and progress | New deprecated manager upload/download APIs; proxying objects when presigned access suffices. |
| SQS/SNS/EventBridge | SDK v2 service clients; Lambda-managed consumers where suitable | Explicit SQS polling lifecycle outside Lambda; EventBridge-generated types for schemas | Inventing an unverified worker-framework recommendation; EventBridge bindings do not orchestrate consumers. |
| Secrets Manager | Parameters/Secrets Lambda Extension or SDK v2 bounded retrieval | `github.com/aws/aws-secretsmanager-caching-go` `1` only after released dependency compatibility review | Assuming master branch's SDK-v2 migration exists in the checked old release. |
| SSM/AppConfig | SDK v2 for writes/freshness; AppConfig Agent for cached reads | Explicit bounded SDK cache outside supported agent deployments | Reimplementing token polling casually; assuming identical freshness for every provider. |
| Cognito/JWT | `github.com/lestrrat-go/jwx/v3` `3` with JWKS cache and Cognito claim policy | Existing audited JWT middleware | Cognito management SDK as a verifier; no issuer/client/token-use checks. |
| RDS/Aurora SQL | `github.com/jackc/pgx/v5/pgxpool` `5` plus SDK `feature/rds/auth` `1` for IAM | AWS Advanced Go Wrapper `awssql` module `1` for required topology/failover/IAM features; verify driver-plugin submodule lines | Root wrapper version substituted for every submodule; redundant pools or unverified proxy/plugin compatibility. |
| Aurora Data API | SDK v2 `service/rdsdata` `1` for explicit Data API calls | Ordinary pooled SQL driver when network/deployment permits | Treating Data API as identical to a SQL socket; unverified engine/region support. |
| Aurora DSQL | `github.com/awslabs/aurora-dsql-connectors/go/pgx` `0.5` when DSQL is selected | Explicit SDK IAM signing with the supported driver | Treating DSQL as interchangeable PostgreSQL; asserting this is the definitive latest submodule from a stale registry banner. |
| OpenSearch | `github.com/opensearch-project/opensearch-go/v4` `4` with AWS signer | Direct signed HTTP for tiny integrations | Wrong signer service: domains use `es`, Serverless uses `aoss`; frozen temporary credentials. |
| Kinesis | SDK v2 for publishing; Lambda-managed consumer for ordinary processing | KCL `3` MultiLangDaemon deployment when leasing/checkpoint lifecycle is needed | Inventing native official Go KCL; KCL `1` support ended in 2026. |
| MSK | Kafka client `github.com/twmb/franz-go` `1` plus `github.com/aws/aws-msk-iam-sasl-signer-go` `1` | Existing compatible Kafka client and auth integration | AWS management SDK for records; static OAuth tokens without refresh. |
| Bedrock | SDK v2 `service/bedrockruntime` `1` Converse/streaming | Application tool loop for demonstrated orchestration needs | Inventing official Go Strands bindings or adding an agent framework for one call. |
| CloudWatch | OTel `1` plus collector for standardized telemetry | SDK v2 for explicit metrics, queries and control-plane calls | Assuming EMF transports itself outside Lambda or using unbounded dimensions. |
| Durable execution | `github.com/aws/aws-durable-execution-sdk-go` `1` for replay/checkpoints | Step Functions for cross-service orchestration; raw SDK for execution management | Ordinary Lambda API calls presented as replay runtime; replay-unsafe effects. |

## Rules

- Initialize reusable clients/providers outside the handler. Invocation wrappers parse/validate, call a business function and serialize; clear invocation-local fields afterward.
- Follow the ADOT Go recipe for invocation-end flush. Do not shut down reusable OTel providers each invocation. Pin the collector extension and test architecture/region support.
- X-Ray SDKs/daemon entered security-only maintenance on `2026-02-25`; the current timeline has no scheduled maintenance end. This is not X-Ray service retirement.
- Enable `ReportBatchItemFailures` in IaC; test poison records and FIFO ordering. Model stable business-operation keys and do not promise exactly-once external effects.
- Use raw SDK calls for simple operations, administration, exact request semantics or features missing from the wrapper. Use protocol clients for database/search/cache/Kafka data planes.
- Verify IAM token refresh and reconnect behavior. ElastiCache tokens last `15` minutes; IAM connections need reauthentication before the documented `12`-hour disconnect. MemoryDB/binding behavior needs its own check.
- Unit-test business logic and adapter failures. Deploy isolated tests for AWS behavior. Local tools do not replace cloud evidence.
- Verify the HTTP adapter's pinned API Gateway event version and streaming behavior. The runtime package and API Proxy adapter are separate modules.

## Sources

- [Go Lambda](https://docs.aws.amazon.com/lambda/latest/dg/lambda-golang.html), [SDK v2](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2), [Powertools inventory](https://github.com/aws-powertools), [Web Adapter](https://github.com/aws/aws-lambda-web-adapter), [ADOT Go recipe](https://aws-otel.github.io/docs/getting-started/lambda/lambda-go), [otellambda](https://pkg.go.dev/go.opentelemetry.io/contrib/instrumentation/github.com/aws/aws-lambda-go/otellambda), [X-Ray timeline](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html).
- [API Proxy standard-handler adapter](https://github.com/awslabs/aws-lambda-go-api-proxy#standard-library), [API Proxy module line](https://pkg.go.dev/github.com/awslabs/aws-lambda-go-api-proxy).
- [DynamoDB helpers](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue), [expressions](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression), [dynamo retry guidance](https://github.com/guregu/dynamo), [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html).
- [GLIDE Go](https://pkg.go.dev/github.com/valkey-io/valkey-glide/go/v2), [GLIDE caching](https://glide.valkey.io/concepts/client-features/client-side-caching/), [ElastiCache IAM](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html), [S3 transfers](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager).
- [Secrets cache](https://pkg.go.dev/github.com/aws/aws-secretsmanager-caching-go), [cache source compatibility](https://github.com/aws/aws-secretsmanager-caching-go/blob/master/go.mod), [Lambda secrets options](https://docs.aws.amazon.com/lambda/latest/dg/with-secrets-manager.html), [AppConfig Agent](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-agent.html), [JWKS/JOSE](https://pkg.go.dev/github.com/lestrrat-go/jwx/v3).
- [Advanced Go Wrapper](https://github.com/aws/aws-advanced-go-wrapper), [awssql checked module](https://pkg.go.dev/github.com/aws/aws-advanced-go-wrapper/awssql), [DSQL Go connector](https://pkg.go.dev/github.com/awslabs/aurora-dsql-connectors/go/pgx), [RDS IAM signer](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/feature/rds/auth), [OpenSearch signing](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-clients.html).
- [KCL non-Java consumers](https://docs.aws.amazon.com/streams/latest/dev/develop-kcl-consumers-non-java.html), [MSK signer](https://pkg.go.dev/github.com/aws/aws-msk-iam-sasl-signer-go), [Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-call.html), [durable Go SDK](https://github.com/aws/aws-durable-execution-sdk-go/releases/tag/v1.0.0), [Lambda testing](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html).
