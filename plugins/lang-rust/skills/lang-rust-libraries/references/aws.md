# AWS and Lambda

Use official service clients and purpose-specific helpers; load `aws-guidance` for AWS architecture and deployment decisions.

Checked 2026-11-12.

## Runtime and middleware decision matrix

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Credentials/configuration | `aws-config` `1.13`, service-specific `aws-sdk-*` `1` | Explicit SDK configuration for tested region/endpoint/freshness requirements | Hardcoded credentials; one imagined ecosystem-wide SDK version; MSRV below `1.94.1` for current config. |
| Event function | `lambda_runtime` `1.5` on `provided.al2023` | HTTP adapter for actual HTTP triggers | Server loop inside a simple event function; business rules inside envelope handling. |
| HTTP Lambda | Same `axum` `0.8` router through `lambda_http` `1.3`, reusing `tower` `0.5` layers | Lambda Web Adapter `1.1` for an existing listening HTTP app/container | Multiple frameworks/body parsers/routers on one HTTP surface; assuming all listeners plug into the HTTP adapter. |
| Event cross-cutting behavior | Runtime service/wrapper around a testable function | Tower `0.5` layers where service signatures fit | Assuming JavaScript Middy or another language's Powertools applies to Rust. |
| Web cross-cutting behavior | Framework `tower` `0.5`, `tower-http` `0.7` | Existing app's framework middleware behind Web Adapter `1.1` | Invocation wrapper substituted for HTTP routing/stream lifecycle behavior. |
| Build/local invoke | `cargo-lambda` `1.9` | Existing SAM local workflow plus isolated cloud tests | Calling Cargo Lambda AWS-owned; emulator success as proof of IAM/cloud behavior. |
| Telemetry | OTel SDK/exporter `0.33`, `tracing-opentelemetry` `0.34`, collector extension | Approved existing exporter with tested Lambda lifecycle | New X-Ray SDK instrumentation, logging mistaken for distributed traces. |

Keep handlers thin: parse and validate, call an independently testable business function, serialize. Reuse SDK clients/providers outside the handler without retaining per-request state. Validate API Gateway/ALB/Function URL bodies, binary payloads, error responses and streaming under the chosen adapter.

## Powertools substitutes

The research identified no official Rust Powertools distribution. Compose the following utilities for Rust-specific boundaries. Check each required capability separately.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Logger/context | `tracing` `0.1`, `tracing-subscriber` `0.3` JSON | Existing approved structured logger | Unredacted events; leaked request fields across reused invocations. |
| Metrics | OTel metrics `0.33` through collector | Approved EMF utility when CloudWatch-specific metrics need it | Casual handwritten EMF wire format; duplicate business metrics. |
| Traces | OTel `0.33`, tracing bridge `0.34`, explicit invocation span/context | Approved collector/vendor extension | Assuming the managed-runtime auto-instrumentation layer covers Rust. |
| Parser/validation | `serde` `1`, `validator` `0.21` plus official event types | `garde` `0.23` contextual validation | Recreated event schemas; unchecked payload assumptions. |
| Idempotency | `aws-sdk-dynamodb` `1` conditional writes, TTL and in-progress/completed records | Downstream operation token or an existing reviewed shared component | Handler-local check-then-write or invocation IDs as business deduplication keys. |
| Batch failures | Official event types and partial-response contract | Existing reviewed batch component | Silent acknowledgment, full-batch replay for isolated failure, broken FIFO ordering. |
| Parameters | SDK `1` with extension/agent or bounded TTL cache | Direct SDK for writes/strict freshness | Fetching unchanged secrets per record. |
| Feature flags | AppConfig agent and typed evaluation | Existing reviewed provider | Inventing Powertools/OpenFeature Rust support or a custom rules engine. |

## Service clients: library versus raw SDK

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| DynamoDB | `aws-sdk-dynamodb` `1`, `serde_dynamo` `4.3` for Serde mapping | `modyne` `0.3` for opinionated single-table modeling and bulk/transaction operations | Typing mistaken for key design, correct cursors or concurrency control. |
| Valkey/ElastiCache/MemoryDB | `redis` `1.8` async protocol client | `fred` `10.1` when richer routing/pipelining fits after maintenance review | AWS management SDK for Redis commands; inferring public Rust GLIDE bindings from its Rust core. |
| S3 | `aws-sdk-s3` `1` for exact operations/presigning | `object_store` `0.14` portable APIs; `opendal` `0.59` broader backends | Abstraction assumed to cover every S3 feature. |
| SQS/SNS/EventBridge | Corresponding `aws-sdk-*` `1` | Existing worker engine with verified adapter lifecycle outside Lambda | External polling inside event-source Lambda; unverified general Rust worker wrapper. |
| Secrets Manager/SSM | Service SDK `1`; Parameters/Secrets Lambda Extension for cached reads | Explicit bounded TTL cache outside Lambda; raw SDK for writes/freshness | Unverified community cache as security default. |
| AppConfig | AppConfig agent, SDK `1` for control plane | Direct data SDK when deployment cannot run agent | Repeated handwritten token/polling lifecycle when agent fits. |
| Cognito | SDK `1` for operations; `jsonwebtoken` `11` for local verification | Existing maintained verifier with rotating JWKS cache | Signature-only policy; missing issuer/client/audience/token-use checks. |
| RDS/Aurora SQL | `sqlx` `0.9` pool or `tokio-postgres` `0.7` with `deadpool-postgres` `0.14` | `bb8` `0.9` generic pool; RDS Proxy for fleet pressure | SDK management API as SQL driver; duplicate/unbounded pools. |
| IAM SQL auth/Data API | SDK `1` signing/Data API, renewable credentials, normal SQL driver otherwise | DSQL `aurora-dsql-sqlx-connector` `0.2` for its IAM integration | DSQL treated as interchangeable PostgreSQL; static IAM tokens; unverified wrapper compatibility. |
| OpenSearch | `opensearch` `2.4` with `aws-auth` and refreshing credentials | Signed HTTP if required APIs are missing; SDK `1` for administration | Wrong SigV4 service: domains use `es`, Serverless `aoss`. |
| Kinesis | SDK `1` producer; managed consumer for lifecycle | Java KCL deployment or reviewed MultiLangDaemon integration | Calling a daemon-based client native Rust; ad hoc shard/checkpoint ownership. |
| MSK | `rdkafka` `0.39` plus reviewed IAM signing when required | Community `aws-msk-iam-sasl-signer` `1` only after ownership/refresh review | Describing community signer as AWS-owned; nonrenewable OAuth token. |
| Bedrock | Runtime SDK `1` Converse/direct inference | `rig-core` `0.46` only when required provider coverage is proven | Inventing official Rust Strands bindings or an agent loop for one call. |
| CloudWatch | OTel `0.33` for standardized telemetry; SDK `1` queries/control | Direct metrics SDK for explicit CloudWatch operations | Assuming EMF is transported automatically outside Lambda. |
| Step Functions/durable execution | SDK `1` for execution administration; workflow authored separately | `temporalio-sdk` `1.2` for durable Rust workflow requirements | Claiming official Rust Lambda durable SDK was verified; replay-unsafe custom runtime. |

## Rules

- Extract trace context and end invocation spans. Use bounded invocation-end flush without shutting reusable providers down each time. Inject active trace/span IDs into logs separately from request IDs.
- X-Ray SDK/daemon maintenance started 2026-02-25; current policy does not specify a maintenance end. This is not retirement of the X-Ray service.
- Configure `ReportBatchItemFailures` and test poison/FIFO records. Test conditional conflicts, retries, visibility renewal, pagination and auth in isolated cloud integration tests.
- IAM support includes renewal/reconnection, not just signing. ElastiCache IAM tokens expire after 15 minutes. Connections need reauthentication before the 12-hour limit.
- Prefer arm64 only after native-layer/extension compatibility and workload checks. Do not assume SnapStart covers OS-only Rust runtimes.
- Official event crate and extension/agent versions were not established in the reports; verify and pin deployment artifacts before adding them.

## Sources

- [AWS SDK Rust](https://github.com/awslabs/aws-sdk-rust), [Lambda Rust runtime](https://github.com/aws/aws-lambda-rust-runtime), [Powertools inventory](https://github.com/aws-powertools), [Web Adapter](https://github.com/aws/aws-lambda-web-adapter).
- [Dynamo mapping](https://crates.io/crates/serde_dynamo), [Modyne](https://github.com/neoeinstein/modyne), [ElastiCache IAM](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html).
- [Secrets extension](https://docs.aws.amazon.com/lambda/latest/dg/with-secrets-manager.html), [AppConfig agent](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-agent.html).
- [DSQL connector](https://crates.io/crates/aurora-dsql-sqlx-connector), [OpenSearch auth](https://docs.rs/opensearch/latest/opensearch/auth/enum.Credentials.html), [community MSK signer](https://crates.io/crates/aws-msk-iam-sasl-signer).
- [Lambda OTel Collector](https://opentelemetry.io/docs/platforms/faas/lambda-collector/), [X-Ray policy](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html), [Lambda testing](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html).
