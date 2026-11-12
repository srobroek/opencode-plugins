# Python on AWS

Choose AWS data-plane helpers and Lambda adapters; load `aws-guidance` for runtime, layer, IAM and infrastructure decisions.

Checked 2026-11-12.

## Runtime and middleware choices

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| AWS SDK | `boto3` `1`, pinned with compatible dependencies and clients reused outside handlers | `aioboto3` `15` or `aiobotocore` `3` for async I/O | Blocking SDK calls on an event loop; rebuilding clients per record; shared user state |
| Lambda runtime | Supported managed Python runtime, selected through `aws-guidance` | Container runtime for native dependency/container reuse needs | Assuming every Python release or wheel has a compatible layer; Powertools metadata lists Python `3.10` through `3.14` |
| Single-purpose events | `aws-lambda-powertools` `3` decorators/direct APIs around thin handler | `middleware_factory` for synchronous reusable invocation policy | Async middleware is unsupported by `lambda_handler_decorator` |
| Single HTTP endpoint on Lambda only | Powertools `Event Handler` resolver with one route | `fastapi` `0.162` plus `mangum` `0.22` when the service also runs outside Lambda | General web framework for envelope parsing alone |
| Multi-route Lambda-only HTTP | Powertools `Event Handler` in `aws-lambda-powertools` `3` | `fastapi` `0.162` plus `mangum` `0.22` when the service also runs outside Lambda | Stacking Powertools Event Handler and FastAPI on one HTTP surface; duplicate routing/error policy |
| Existing ASGI app | `mangum` `0.22` event-to-ASGI adapter | Lambda Web Adapter `1.1` for an actual HTTP server, streaming and container reuse | Neither adapter makes FastAPI a general queue/batch processor |
| Same API in containers | `fastapi` `0.162`, `uvicorn` `0.54`, Lambda Web Adapter `1.1` | `mangum` `0.22` instead of the Web Adapter when no port-listening server is wanted | Invocation decorators cannot simply wrap a port-listening server; use explicit request/business APIs |
| Integrated AWS app workflow | Keep existing deployment stack | `chalice` `1` for integrated routes/events, packaging, provisioning and local deployment | Calling Chalice abandoned despite recent releases; choosing it for container portability |
| Lambda traces | Application Signals-enabled AWS OTel layer, pinned in IaC | Plain ADOT/upstream Lambda collector for custom backends; manual SDK for unsupported modes | Powertools `Tracer` wraps X-Ray SDK and does not emit OTLP; overlapping SDK patches create duplicate spans |
| Lambda logs/metrics | Powertools `Logger` plus `Metrics` EMF in `aws-lambda-powertools` `3` | OTel business metrics for an approved multi-backend requirement | Publishing the same metric twice; assuming X-Ray correlation is automatic OTel correlation |
| Restore/architecture | Evaluate SnapStart for eligible Python `3.12` or later; arm64 after native dependency tests | Provisioned concurrency for stricter latency; x86 for incompatible native code | Snapshotting unique IDs/stale credentials/unvalidated connections; unverified cold-start rankings |

Head-to-head: Powertools Event Handler owns Lambda-only HTTP; FastAPI owns services that also run outside Lambda. Use one framework per HTTP surface, never both. Mangum translates invocation events and lifespan; Web Adapter runs the server and adds readiness/init machinery. Choose by deployment/lifecycle requirements. No comparable cold-start benchmarks were verified.

## Powertools utilities

All utilities below are in `aws-lambda-powertools` `3`; add only those the function needs.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| JSON context logs/business metrics | `Logger`, `Metrics` | Service logger outside event-function boundary | Homemade context enrichment/EMF documents |
| Typed parsing/schema checks | `Parser` with `pydantic` `2`; `Validation` for JSON Schema | Existing validated domain boundary | Ad hoc envelope chains/unchecked fields |
| AWS event types | `Data Classes`, `Typing` | Parser models for validation | Recreated event schemas; static types alone do not validate |
| Duplicate suppression | `Idempotency` | Downstream native tokens plus reviewed atomic operation records | Check-then-write deduplication; invocation ID as business key |
| SQS/Kinesis/DynamoDB batches | `Batch Processing` | Individual handlers for other source contracts | Whole-batch retry for isolated failures; omitting `ReportBatchItemFailures` in IaC |
| Cached secrets/config | `Parameters` | Agent/extension or raw SDK for explicit freshness/writes | Fetching unchanged secrets per invocation or record |
| HTTP/AppSync/Bedrock action groups | `Event Handler` | Existing web framework/agent SDK for their distinct responsibilities | Repeated envelope dispatch/response code; resolver mistaken for agent orchestration |
| Feature rules | `Feature Flags` | `openfeature-sdk` `0.10` for provider-independent service evaluation | Custom rules engine without a named gap |
| S3 datasets | `Streaming` | SDK transfer helpers for object transfers | Loading full datasets into memory; confusing dataset streaming with HTTP responses |
| Sensitive fields/encoded queries | `Data Masking`, `JMESPath Functions` | Format-specific boundary handling | Homemade crypto/masking; repeated base64/JSON decoding chains |
| Kafka payloads/metadata | `Kafka`, `Metadata` | Existing verified deserializer/runtime facility | Rewriting schema-registry decoding or metadata endpoint protocol |
| Additional policy | `Circuit Breaker`, `Middleware Factory` | Existing reviewed service policy | Assuming `Auth` alpha is a production auth default |
| Tracing | ADOT layer, without `Tracer` | Legacy X-Ray integration only during an explicit migration | X-Ray SDK/daemon have security-only maintenance since `2026-02-25`; current timeline has no scheduled end, not service retirement |

## Service client libraries versus raw SDK

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| DynamoDB | `boto3` `1` client/resource for simple operations | `pynamodb` `6` for model mapping, transactions and optimistic locking; `aioboto3` `15` for async I/O | New `pydantic-dynamo` adoption has stale maintenance evidence; resource API gets no new features |
| ElastiCache/MemoryDB commands | `valkey-glide` `2` for async AWS clusters/IAM automation | `redis` `8` or `valkey` `6` for existing APIs/ecosystems | AWS SDK administers, not cache commands; Python GLIDE cache features differ from other bindings |
| S3 | `boto3` `1` `upload_file`/`download_file`, `S3Transfer`/`TransferConfig` | `s3fs` `2026` for file APIs; `obstore` `0.12` for portable object APIs; CRT transfers after throughput tests | Homemade multipart orchestration; assuming object storage is POSIX |
| SQS/SNS/EventBridge | `boto3` `1` for publishing and managed-lifecycle workers; Powertools Batch on Lambda | `celery`/`kombu` `5` for actual task architecture; `dramatiq-sqs` `0.5` in existing Dramatiq apps | Celery merely to poll domain events: SQS transport has visibility/remote-control/event limitations |
| Secrets Manager/SSM/AppConfig | Powertools `Parameters`; AppConfig Agent for local cache/polling/token lifecycle | `aws-secretsmanager-caching` `1` for Secrets-only apps; SDK for writes or explicit freshness | Fetch-on-every-call; unbounded TTL caches; raw SDK replaces no refresh policy |
| Cognito/JWT | `boto3` `1` for Cognito operations; `PyJWT` `2` JWKS client plus explicit claims | `joserfc` `1`/`python-jose` `3` for JOSE; `pycognito` `2024` for auth workflows | Signature verification alone is not authorization; validate issuer, client/audience and token use |
| RDS/Aurora SQL and IAM | `psycopg` `3`/`SQLAlchemy` `2` pool; SDK IAM token generation | `aws-advanced-python-wrapper` `3` for Aurora topology/failover/IAM plugins; RDS Proxy for fleet connection pressure | Wrapper without required topology features; stale IAM token when opening a new connection |
| Aurora Data API/DSQL | `boto3` `1` Data API for eligible engines/regions | `aurora-dsql-python-connector` `0.2` for DSQL IAM connections | Treating DSQL as interchangeable PostgreSQL; unverified proxy/plugin/region compatibility |
| OpenSearch | `opensearch-py` `3`, transport-matched built-in AWS signer | `requests-aws4auth` `1` for existing Requests integrations; AWS SDK for administration | Frozen temporary credentials; use signing service `es` for domains and `aoss` for Serverless |
| Kinesis | `boto3` `1` producers; Lambda managed consumer | `amazon-kclpy` `3` when worker leases/checkpoints/shard lifecycle are needed | KCL `1` support ended `2026-01-30`; KCL Python requires a Java daemon |
| MSK records | `confluent-kafka` `2` or `aiokafka` `0.15`, plus `aws-msk-iam-sasl-signer-python` `1` | Existing supported Kafka authentication | AWS management SDK is not Kafka protocol; static OAuth token without refresh |
| Bedrock | `boto3` `1` runtime Converse for direct inference | `anthropic[bedrock]` `2` for Claude-specific calls; `strands-agents` `1` for agent loop; `bedrock-agentcore` `1` for AgentCore services | Agent framework for one inference request |
| CloudWatch | Powertools Metrics on Lambda; OTel for service telemetry | `aws-embedded-metrics` `3` for standalone EMF; SDK for queries/control | High-cardinality dimensions; assuming EMF is automatically transported outside Lambda |
| Durable execution | `aws-durable-execution-sdk-python` `3` for replay/checkpoints | Step Functions for cross-service workflow orchestration; SDK for execution administration | Sleeping in billed handlers; replay-unsafe side effects; management API is not durable runtime |
| Local/cloud tests | `moto` `5`, SDK stubs, SAM local invocation; DynamoDB Local for API integration | LocalStack for cross-service workflows; isolated deployed integration tests | Emulator success does not prove IAM, retries, concurrency, service limits or telemetry correctness |

## Rules

- Thin handler: establish invocation context, parse/validate, call a testable business function, serialize. Put cross-cutting concerns in invocation decorators or Event Handler middleware, not every business function.
- Configure regional Application Signals layer, `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument` and role permissions through `aws-guidance`. Container images incorporate layer contents at build time. Remove conflicting X-Ray SDK instrumentation.
- Align `OTEL_SERVICE_NAME` and `POWERTOOLS_SERVICE_NAME`. Attach active `trace_id`/`span_id`, retain request ID separately, and clear invocation fields after use. Verify invocation-end flush; do not shut down reusable providers per invocation.
- IAM support means signing plus refresh/reconnect/expiry handling. ElastiCache tokens last `15` minutes; reauthenticate connections before their `12`-hour limit. GLIDE binding-specific MemoryDB/cache behavior still needs verification.
- Choose wrappers for a concrete burden: mapping, leases, multipart, caching, failover or replay. Keep a raw-SDK path for unsupported features and exact request semantics.

## Sources

- [Boto3](https://docs.aws.amazon.com/boto3/latest/), [resources policy](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/resources.html), [S3 transfers](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/s3.html)
- [Powertools inventory](https://docs.aws.amazon.com/powertools/python/latest/), [middleware factory](https://docs.aws.amazon.com/powertools/python/latest/utilities/middleware_factory/), [HTTP resolver](https://docs.aws.amazon.com/powertools/python/latest/core/event_handler/api_gateway/)
- [Mangum](https://mangum.fastapiexpert.com/), [Web Adapter](https://github.com/aws/aws-lambda-web-adapter), [Chalice](https://aws.github.io/chalice/)
- [Application Signals layer](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-Enable-Lambda.html), [X-Ray timeline](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html)
- [PynamoDB locking](https://pynamodb.readthedocs.io/en/latest/optimistic_locking.html), [GLIDE](https://github.com/valkey-io/valkey-glide), [cache capabilities](https://glide.valkey.io/concepts/client-features/client-side-caching/), [ElastiCache IAM](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html)
- [Celery SQS](https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/sqs.html), [Parameters](https://docs.aws.amazon.com/powertools/python/latest/utilities/parameters/), [AppConfig Agent](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-agent.html)
- [Aurora wrapper](https://github.com/awslabs/aws-advanced-python-wrapper), [DSQL connectors](https://github.com/awslabs/aurora-dsql-connectors), [OpenSearch signers](https://github.com/opensearch-project/opensearch-py/blob/main/guides/auth.md)
- [KCL](https://docs.aws.amazon.com/streams/latest/dev/kcl.html), [MSK IAM](https://docs.aws.amazon.com/msk/latest/developerguide/configure-clients-for-iam-access-control.html), [Strands](https://github.com/strands-agents/harness-sdk)
- [Durable SDK inventory](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk.html), [AWS testing](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html), [Package version registry](https://pypi.org/)
