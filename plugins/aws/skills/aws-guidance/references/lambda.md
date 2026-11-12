# AWS Lambda standards

Read before you write or change a Lambda function. Checked 2026-11-12. Per-language packages and handler examples are in `lang-<language>-libraries`, `references/aws.md`.

## Handler structure

- A handler is a thin adapter: read the event and context, parse and validate, call a business function you can test without Lambda, serialize the result. Initialize SDK clients, configuration and connections outside the handler and reuse them; never keep request data in module state.
- Cross-cutting concerns go in middleware or decorators, one model per surface:

| Workload | Python | TypeScript |
| --- | --- | --- |
| Event-driven function (SQS, SNS, EventBridge, S3, DynamoDB streams, Kinesis, schedules) | Plain handler with Powertools decorators and utilities; `lambda_handler_decorator` (synchronous only) for custom policy | Plain typed handler with Powertools utilities used directly; Middy 7 only when several ordered lifecycle concerns justify it |
| HTTP on Lambda only | Powertools Event Handler (REST/HTTP API, ALB, Function URL, VPC Lattice) with its route and global middleware | Hono through `@hono/aws-lambda` (`handle`, `streamHandle`), with Powertools Logger and Metrics in a Hono middleware |
| Same HTTP API also in containers | FastAPI with Mangum, or with the Lambda Web Adapter | The same Hono app; on Lambda Web Functions (Node 24, arm64) as a native server, else the adapter |

- Go: `aws-lambda-go` on `provided.al2023` (`go1.x` is deprecated); reuse a `net/http` handler through the Lambda Web Adapter for HTTP. Rust: `lambda_runtime`, `lambda_http` for an axum router, built with `cargo-lambda` (third party, recommended in AWS docs).
- Never wrap a web framework in a Lambda middleware engine, and never stack two body parsers, routers, loggers or metrics middlewares.

## Powertools for AWS Lambda first

Official for Python (major 3), TypeScript (major 2), Java (major 2) and .NET (major 3). There is no official Powertools for Go or Rust; community ports are not AWS-supported.

| Concern | Use | Do not hand-roll |
| --- | --- | --- |
| Structured JSON logs with Lambda context, cold start, correlation ids, sampling, buffering | Logger | Your own JSON formatter or context enrichment |
| Business metrics | Metrics (EMF, asynchronous) | `PutMetricData` per invocation or hand-built EMF |
| Duplicate suppression | Idempotency, keyed on a stable business key (not the request id) | Check-then-write deduplication |
| SQS, Kinesis and DynamoDB stream batches | Batch Processing with `ReportBatchItemFailures` enabled in the event source mapping | Whole-batch retries for one bad record |
| Cached secrets, parameters, AppConfig | Parameters | A fetch per invocation or an unbounded cache |
| Event parsing and validation | Parser (Pydantic, Zod), Validation (JSON Schema), event source data classes | Ad hoc envelope decoding and casts |
| Lambda-only HTTP routing (Python), AppSync and Bedrock Agents routing (Python, TypeScript) | Event Handler; TypeScript HTTP uses Hono | Hand-written proxy-event routing |
| Feature rules, data masking, large-object streaming, Kafka deserialization | Feature Flags, Data Masking, Streaming (Python), Kafka | A rules engine, masking crypto, whole-object loads, schema-registry decoding |

## Telemetry on Lambda

- AWS X-Ray SDKs and the daemon are in security-fixes-only maintenance since 2026-02-25. Powertools Tracer wraps the X-Ray SDK in every runtime, so new functions do not use it.
- Python, Node, Java, .NET: the Application Signals-enabled ADOT Lambda layer, pinned in infrastructure code, with `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`. Use the upstream OpenTelemetry Lambda layers when the backend is not AWS. Remove X-Ray SDK instrumentation: two SDKs patching the same clients duplicate spans.
- Go and Rust: OTel SDK with manual instrumentation (`otellambda.InstrumentHandler` in Go; `tracing-opentelemetry` in Rust), the ADOT Collector extension, and a flush at the end of every invocation. The X-Ray OTLP endpoint needs Transaction Search enabled.
- Keep Powertools Logger and Metrics. Add the active OTel `trace_id` and `span_id` to log entries, keep the Lambda request id as its own field, and set `OTEL_SERVICE_NAME` and `POWERTOOLS_SERVICE_NAME` to the same value. Business metrics stay EMF; never publish the same metric through both EMF and OTel.

## Logging and metrics on Lambda

With the JSON log format, Python `logging` and Node `console` already get `timestamp`, `level`, `message` and `requestId` from the runtime. Go and Rust format their own JSON. Custom JSON needs a string `level` and an RFC 3339 `timestamp`, or log-level filtering treats the line as INFO.

| Language | Default | Choose instead when | Avoid |
| --- | --- | --- | --- |
| Python | Powertools Logger and Metrics | Plain `logging` for small functions with no business metrics; `structlog` or `loguru` only where the project already standardizes on them; `aws-embedded-metrics` 3 for metrics-only code shared with containers | Invocation keys left bound across warm calls; a queue sink that is not flushed before the handler returns |
| TypeScript | Powertools Logger and Metrics | `console` for minimal functions; Pino with `pino-lambda` 4 (its `StructuredLogFormatter`) for an existing Pino setup, after checking it works with Pino 10; `aws-embedded-metrics` 4.1.1 or later for metrics-only code | The `pino-lambda` default text formatter; raw numeric Pino levels with log-level filtering |
| Go | `log/slog` JSON with a handler that adds the invocation request id, cold start and active trace ids | `prozz/aws-embedded-metrics-golang` for business metrics after an ownership review (last release 2021); OTel metrics through the Collector on an OTel platform | Community Powertools ports presented as official; shared mutable invocation attributes |
| Rust | `tracing-subscriber` JSON with invocation spans carrying the request id | `metrics_cloudwatch_embedded` 0.10 for business metrics (flushes per invocation; histograms keep 100 samples and error on overflow); OTel metrics through the Collector | Timer-only flushing; ignored histogram overflow |

- EMF limits: 30 dimensions per set (29 user dimensions in Powertools), 100 metric definitions and 100 values per array in one event, 1 MB per event. Every distinct dimension combination is a new metric: put request ids in properties, never in dimensions.
- Application Signals gives request, latency, error and fault metrics plus traces for the APM view. It does not replace business metrics or logging.
- The OpenTelemetry Lambda Collector extension exports traces and metrics by default but not logs; configure a logs pipeline explicitly if you want OTLP logs. Test flushing before the runtime freezes, on Collector shutdown and on export failure; synchronous export adds latency to billed duration.

## Runtime defaults

- Logging: JSON log format with Lambda advanced logging controls, INFO by default, a retention period, no payload logging by default.
- Architecture: arm64 after a benchmark; x86_64 for native dependencies that need it. Check that every layer and extension supports arm64.
- Cold starts: SnapStart for latency-sensitive functions on Java 11 or later, Python 3.12 or later, or .NET 8 or later, after restore testing (no unique ids, credentials or connections captured in the snapshot); provisioned concurrency for stricter targets. Keep bundles small and measure Init Duration.
- Delivery is at least once: idempotent handlers, partial batch responses, dead-letter queues or on-failure destinations; never claim exactly-once side effects.
- Long workflows: Lambda durable functions (SDKs for JS/TS, Python, Java, Go, .NET) for code-centric steps and waits; Step Functions for cross-service orchestration. Never sleep inside a billed handler.
- Testing: unit-test the business function; replay synthetic events against the handler; run deployed integration tests that cover IAM, retries, partial batches and telemetry. Local emulation (SAM local, LocalStack, moto, DynamoDB Local) does not prove cloud behavior.

## Sources

- Powertools: https://github.com/aws-powertools
- X-Ray SDK timeline: https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html
- Application Signals for Lambda: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-Enable-Lambda.html
- ADOT Go: https://aws-otel.github.io/docs/getting-started/lambda/lambda-go
- Lambda best practices: https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html
- Lambda testing guide: https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html
- Lambda Web Functions: https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html
- Lambda Web Adapter: https://github.com/aws/aws-lambda-web-adapter
- Middy 7: https://middy.js.org/docs/upgrade/6-7/
- Hono on Lambda: https://hono.dev/docs/getting-started/aws-lambda
- Durable functions: https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html
