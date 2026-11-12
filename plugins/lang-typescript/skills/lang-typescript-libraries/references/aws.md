# AWS and Lambda

Choose thin Lambda adapters, Powertools utilities and service clients instead of recreating SDK behavior.

Checked 2026-11-12.

Hono (`hono` `4`) is an HTTP framework: portable routing, Fetch request/response
handling and onion middleware. Middy (`@middy/core` `7`) is a Lambda invocation
middleware engine for HTTP and non-HTTP events. Pino (`pino` `10`) is a structured
JSON logger with child loggers, redaction and transports. Powertools (`2`) is a
Lambda utility toolkit; its HTTP Event Handler has its own middleware protocol,
not Middy's. None of these names denotes the same layer.

## Lambda decision matrix

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| SDK/runtime | Modular `@aws-sdk/client-*` `3`; supported managed Node runtime, preferably Node `24` where available | Bun custom/container runtime only for an intentional, tested deployment. | `aws-sdk` `2`: support ended `2025-09-08`; relying on the runtime's SDK version instead of packaging yours. |
| Single-purpose event handler | Powertools `2` direct APIs and utility wrappers | `@middy/core` `7` when several invocation concerns need ordered lifecycle phases. | HTTP routers for SQS, SNS, EventBridge, S3, DynamoDB or Kinesis processing. |
| Every HTTP endpoint/API | `hono` `4` with the `@hono/aws-lambda` adapter on Event Functions | `@aws-lambda-powertools/event-handler` `2` only for Lambda-only teams explicitly wanting no web framework. | Wrapping Hono in Middy; competing body parsers/routers/error mapping. |
| HTTP on Web Functions | Native Hono Node server | Event Functions with adapter for required event/context deployment semantics. | Assuming traditional handler bindings on a native server or supported Bun deployment on Web Functions. |
| Same HTTP app in containers | `hono` `4` plus runtime adapters | AWS Lambda Web Adapter `1.1` for existing port-listening Fastify/Express apps; `@fastify/aws-lambda` `6` for a Fastify proxy adapter. | Rewriting existing server middleware solely for Lambda; assuming forwarded queue events acquire partial-batch semantics. |
| HTTP server deployment | Evaluate native AWS Lambda Web Functions for new Node HTTP services | Existing adapter deployment when portability/deployment restrictions require it. Web Functions launched with Node `24`, Arm64, zip deployment and port-listening servers. | Treating Web Functions as a middleware package, Bun runtime, or ordinary event/context handler; global request state under concurrent requests. |
| Logger | Powertools Logger `2` on Event Functions; `pino` `10` in Hono services/containers/Web Functions | Powertools Logger inside Hono on Lambda for Lambda context fields. | Claiming Pino itself enriches Lambda context; mutable global request bindings in concurrent servers. |
| Traces | Application Signals-enabled ADOT Lambda layer plus its documented configuration | Manual OTel SDK when the layer does not fit the deployment. | Powertools Tracer for new defaults: it wraps the X-Ray SDK, in maintenance since `2026-02-25`. |
| Business metrics | `@aws-lambda-powertools/metrics` `2` EMF | OTel metrics for the shared service telemetry pipeline when deliberately configured. | Handwritten EMF or synchronous metric calls per record. |

## Powertools utilities

All packages below use line `2`. Add only the utilities the function needs.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Invocation logging | `@aws-lambda-powertools/logger` | Direct APIs for simple functions; supported middleware/decorators for repeated lifecycle integration. | Losing context/cold-start metadata, or retaining warm-invocation fields. |
| EMF metrics | `@aws-lambda-powertools/metrics` | Shared OTel pipeline where service portability is the requirement. | Forgetting publication/cleanup on failure paths. |
| Duplicate effects | `@aws-lambda-powertools/idempotency` | Database transaction/uniqueness when it owns the effect atomically. | Check-then-write deduplication races; assuming a cache makes an external effect exactly once. |
| Partial batches | `@aws-lambda-powertools/batch` | Custom processor only for an unsupported event/source requirement. | Whole-batch retries after one record fails. |
| Cached configuration | `@aws-lambda-powertools/parameters` | AWS Parameters and Secrets extension or AppConfig agent for deployment-owned caching. | Fetching every record; secrets without bounded TTL/rotation behavior. |
| Feature flags | `@openfeature/server-sdk` `1`; simple runtime toggles: `@openfeature/aws-ssm-provider` `0.1`, cache off by default, only boolean/string results cached | AppConfig Agent for kill switches/rollout: no maintained provider found, ask before writing one; deploy-time flags: `@openfeature/flagd-provider` `0.18` over generated flags.json from flags.yaml | Silent Agent wrapper fallback; browsers use server decisions or ask first, never AWS credentials/Agent; see `aws-guidance` and `quality-code-design`'s `feature-flags.md`. |
| Typed events | `@aws-lambda-powertools/parser` plus `zod` `4` | `@aws-lambda-powertools/validation` for JSON Schema requirements. | Unchecked event casts or manual envelope decoding. |
| AppSync and Bedrock Agents routing | `@aws-lambda-powertools/event-handler` | A direct handler for one resolver or action. | Using it for HTTP: Hono owns TypeScript HTTP; mixing HTTP middleware with record-batch processing. |
| Sensitive data masking | `@aws-lambda-powertools/data-masking` | Logger field redaction for ordinary logging-only concerns. | Assuming masking replaces authorization or encryption. |
| Encoded-payload queries | `@aws-lambda-powertools/jmespath` | Native access when no encoded envelope is involved. | Repeated base64/JSON envelope chains. |
| Kafka payloads | `@aws-lambda-powertools/kafka` | Existing reviewed broker schema-registry integration. | Handwritten Avro/Protobuf envelope decoding. |
| SigV4 | `@aws-lambda-powertools/signer` | SDK signing for SDK-covered APIs. | Recreating canonical requests/credential refresh. |
| Legacy X-Ray | Existing `@aws-lambda-powertools/tracer` only during a planned migration | ADOT/OTel for the new trace pipeline. | Adding both providers and emitting duplicate spans. |

## Service clients versus raw SDK

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| DynamoDB CRUD | `@aws-sdk/lib-dynamodb` `3` DocumentClient | `electrodb` `3` for typed single-table access patterns/relationships; `dynamodb-toolbox` `2` for lighter entity/builders. | New `dynamodb-onetable` adoption: archived and explicitly unmaintained; treating models as concurrency protection. |
| DynamoDB concurrency | SDK `3` conditional writes and transactions, surfaced through the chosen model | Model library when it reduces key/condition/pagination duplication. | Unconditional updates or incomplete pagination; wrong undefined-value marshalling assumptions. |
| Valkey/ElastiCache | `@valkey/valkey-glide` `2` when its cluster/IAM/features and native targets fit | `redis` `6` or `ioredis` `6` for existing integrations/portable JS constraints. | Assuming Bun/native compatibility or IAM token refresh without tests; static expiring tokens. |
| Valkey cache semantics | GLIDE `2` with an explicit acceptable-staleness policy | Protocol client/server-assisted invalidation only when the binding documents it. | Treating GLIDE TTL-only cache as write-invalidated; assuming MemoryDB binding parity. |
| S3 | `@aws-sdk/client-s3` `3` | `@aws-sdk/lib-storage` `3` for multipart uploads; `@aws-sdk/s3-request-presigner` `3` for signed URLs. | Handwritten multipart state/signing; treating presigned URLs as permanent public credentials. |
| SQS consumers | SDK `3` producers; Powertools Batch `2` on Lambda | `sqs-consumer` `15` for long-running polling, visibility/ack lifecycle. | Lambda polling loops; assuming a consumer library provides durable exactly-once effects. |
| SNS/EventBridge | `@aws-sdk/client-sns`, `@aws-sdk/client-eventbridge` `3` | Existing typed envelope/CloudEvents tooling for the domain contract. | Wrapper libraries that add no delivery or domain semantics. |
| Secrets/SSM/AppConfig | Powertools Parameters `2` for cached retrieval | SDK `3` for control-plane operations; deployment agent/extension for shared caching. | Logging values; unbounded cache lifetimes or hand-built refresh machinery. |
| Cognito JWT | `aws-jwt-verify` `5` | `jose` `6` for generic OIDC/JOSE issuers; Cognito SDK `3` for admin/control-plane calls. | Decoding without verifying token use, audience/client identity, issuer and signing keys. |
| RDS/Aurora SQL | `pg` `8` or chosen SQL driver; `@aws-sdk/rds-signer` `3` for IAM tokens | `aws-advanced-nodejs-wrapper` `3` for supported failover/IAM plugins; RDS Proxy for connection pressure. | Assuming wrapper support for Aurora Global Database failover; raw control-plane SDK as a SQL client; non-TLS IAM auth. |
| Aurora Data API | `@aws-sdk/client-rds-data` `3` | `drizzle-orm` `0.45` Data API adapter or `kysely-data-api` `2` when typed queries/mapping justify it. | Assuming transactions/pooling/SQL results match a socket driver exactly. |
| Aurora DSQL | `@aws/aurora-dsql-node-postgres-connector` `0.1` for its auth integration | Explicit signer plus supported PostgreSQL driver for unusual setup. | Confusing DSQL authentication/transaction semantics with ordinary Aurora. |
| OpenSearch | `@opensearch-project/opensearch` `3` with its AWS SigV4 signer | SDK `3` for control plane only. | Handwritten signing; wrong service name: managed `es` versus serverless `aoss`. |
| Kinesis/MSK | `@aws-sdk/client-kinesis` `3` for simple API calls; broker client for MSK | KCL deployment when leases/checkpoints/resharding justify it; `aws-msk-iam-sasl-signer-js` `1` with compatible Kafka auth. | AWS SDK as a Kafka consumer; assuming a Node KCL binding removes its Java daemon dependency. |
| Kinesis leasing | `aws-kcl` `3` when managed leases/checkpoints/resharding justify the Java daemon | Lambda event-source mapping for managed processing. | KCL `1`: support ended `2026-01-30`; calling the Node binding a native-only stack. |
| Bedrock | `@aws-sdk/client-bedrock-runtime` `3` Converse for direct inference | `@ai-sdk/amazon-bedrock` `5` with `ai` `7` for provider-neutral UI/tools; `@strands-agents/sdk` `1` for an agent-loop requirement. | Handwritten tool-call orchestration when a selected SDK covers it; unsafe tool authorization. |
| Claude on Bedrock | `@anthropic-ai/bedrock-sdk` `1` when Claude-native features are needed | Direct Converse or AI SDK for provider-neutral APIs. | Accidentally using an AI Gateway path when direct AWS access is required. |
| CloudWatch EMF outside Lambda | `aws-embedded-metrics` `4` when standalone EMF is required | OTel for shared service telemetry; Powertools Metrics `2` on Lambda. | Assuming EMF is collected without a configured platform log path. |
| Durable Lambda | `@aws/durable-execution-sdk-js` `3` for checkpoint/replay/steps/waits | Step Functions for visual cross-service orchestration; raw SDK `3` for execution administration. | Sleeping in handlers; replay-unsafe effects; treating the Lambda management client as a replay runtime. |
| Local tests | `aws-sdk-client-mock` `4` at SDK boundaries; DynamoDB Local for engine behavior | LocalStack for selected integration services; a deployed smoke test for IAM/event-source behavior. | Treating emulator support as proof of AWS IAM, timing, retries or service parity. |

## Rules

- Parse/validate, call a testable business function, serialize: keep handlers thin.
  Create reusable clients outside the handler; clear invocation-owned state afterwards.
- Middy `7` requires Node `22` or newer; Powertools `2.36` accepts Middy `4` through `7`.
  Match peers rather than upgrading the middleware engine independently.
- Never wrap Hono in Middy. Middy `7` is optional only for non-HTTP event handlers with
  several ordered lifecycle concerns. Current Hono Lambda docs use `@hono/aws-lambda`;
  check the pinned adapter instead of copying historical `hono/aws-lambda` imports.
- Use `handle` for buffered Hono responses and `streamHandle` only with a compatible
  front door and tested cleanup. Web Functions have no handler wrapper.
  Fastify's adapter uses `inject`, not sockets,
  and is not an Express adapter. Test Hono with `app.request()` and handlers with event fixtures.
- Web Functions and ordinary HTTP servers use request-local Pino children. Powertools
  Logger adds Lambda context, cold-start, sampling, correlation and invocation buffering;
  explicitly flush/clear buffers. `pino-lambda` `4` provides Lambda tracking/formatters,
  but its old release and claimed maintenance require review before new adoption.
- Hono is the HTTP default for portability, one middleware model, built-ins, typed `hc`
  clients and `app.request()` tests. In a small Hono Lambda middleware, read the original
  event and context from adapter bindings, enrich Powertools Logger, collect Metrics,
  flush metrics per request in cleanup, and clear request fields. Test error/early-return
  and streaming paths. Hono supplies no AWS-event semantics: Batch, Parser and effect
  Idempotency stay Powertools. Non-HTTP sources use plain typed handlers and direct utilities.
- Enable `ReportBatchItemFailures` for SQS/DynamoDB/Kinesis batch integrations in IaC.
  Batch is not a universal SNS/EventBridge/S3 processor. Idempotency belongs around the
  business effect, not an entire multi-route API. Reuse and do not shut down OTel providers per invocation.
- Configure the regional Application Signals layer, `AWS_LAMBDA_EXEC_WRAPPER`, permissions
  and tracing settings from AWS's guide; container images incorporate layer contents.
  Align `OTEL_SERVICE_NAME` and `POWERTOOLS_SERVICE_NAME`; keep request IDs separate.
- Use ADOT for traces, Powertools Logger and Metrics for Lambda logs/EMF, and add
  active OTel trace/span IDs explicitly where needed. Check layer architecture/region.
- No verified cold-start or bundle-size head-to-head numbers are available here;
  measure the deployed artifact rather than claiming a universal winner.
- Use raw SDK APIs when request shapes/control-plane coverage matter and a higher-level
  library adds no useful mapping, lifecycle, signing, pooling or domain semantics.

## Sources

- [Powertools TypeScript](https://docs.aws.amazon.com/powertools/typescript/latest/), [release and package compatibility](https://github.com/aws-powertools/powertools-lambda-typescript/releases/tag/v2.36.0).
- [Middy integration](https://middy.js.org/docs/integrations/lambda-powertools), [Middy `7` migration](https://middy.js.org/docs/upgrade/6-7/), [Hono Lambda](https://hono.dev/docs/getting-started/aws-lambda).
- [Hono adapter package line](https://registry.npmjs.org/@hono%2Faws-lambda).
- [Web Adapter](https://github.com/aws/aws-lambda-web-adapter), [Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html), [ADOT Lambda](https://aws-otel.github.io/docs/getting-started/lambda).
- [SDK `2` support](https://aws.amazon.com/blogs/developer/announcing-end-of-support-for-aws-sdk-for-javascript-v2/), [X-Ray support](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-migration.html).
- [ElectroDB](https://electrodb.dev/en/core-concepts/introduction/), [Toolbox](https://www.dynamodbtoolbox.com/docs/getting-started/overview), [OneTable status](https://github.com/sensedeep/dynamodb-onetable).
- [GLIDE](https://glide.valkey.io/), [ElastiCache IAM](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html), [AWS JWT Verify](https://github.com/awslabs/aws-jwt-verify).
- [Advanced Node wrapper](https://github.com/aws/aws-advanced-nodejs-wrapper), [Drizzle Data API](https://orm.drizzle.team/docs/connect-aws-data-api-pg), [OpenSearch client](https://github.com/opensearch-project/opensearch-js/blob/main/USER_GUIDE.md).
- [MSK IAM](https://docs.aws.amazon.com/msk/latest/developerguide/configure-clients-for-iam-access-control.html), [Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-call.html), [registry metadata](https://registry.npmjs.org/).
