# Go jobs and messaging

Use broker-native clients and reviewed delivery policies for durable work, not detached goroutines.

Checked 2026-11-12. Standard-library entries use Go `1.27`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| In-process work | `context`, channels and bounded goroutines; standard library is sufficient for non-durable work | A durable queue when accepted work must survive termination | Returning success before non-durable work completes when durability is promised. |
| PostgreSQL jobs | `github.com/riverqueue/river` `0.51` for applications already using PostgreSQL | `github.com/hibiken/asynq` `0.26` for Redis task queues | Detached goroutines for durable jobs; nontransactional enqueue after a required database write. |
| Durable workflows | `go.temporal.io/sdk` `1` for multi-step durable orchestration | `github.com/aws/aws-durable-execution-sdk-go` `1` for Lambda replay/checkpoints; AWS Step Functions for cross-service orchestration | Ordinary nondeterministic work or uncontrolled effects during replay. |
| Simple periodic work | `time.Ticker`; standard library is sufficient | `github.com/robfig/cron/v3` `3` for cron expressions; `github.com/go-co-op/gocron/v2` `2` for richer scheduling/coordination | Treating in-process scheduling as durable distributed execution; inferring abandonment from cron's old tag. |
| Durable schedules | Managed scheduler invoking an idempotent worker | Temporal `1` schedules when already using Temporal | Sleeping in billed Lambda handlers or a per-replica timer issuing duplicate writes. |
| Kafka | `github.com/twmb/franz-go` `1` | `github.com/IBM/sarama` `1` for existing systems; `github.com/confluentinc/confluent-kafka-go/v2` `2` for librdkafka requirements | Old Shopify Sarama imports; native deployment burden without need. |
| RabbitMQ | `github.com/rabbitmq/amqp091-go` `1` | Broker-specific protocols for explicit requirements | Assuming automatic reconnection or topology restoration. |
| NATS | `github.com/nats-io/nats.go` `1` with its `jetstream` API for durable consumers | Core NATS for transient pub/sub | New durable consumers on legacy JetStream interfaces. |
| Pipeline abstraction | Direct broker client first | `github.com/ThreeDotsLabs/watermill` `1` for reusable pipelines/adapters | Hiding ordering, acknowledgment and retry semantics behind generic interfaces. |
| AWS publishing | AWS SDK v2 service clients for SQS, SNS and EventBridge | Existing framework queue adapter when lifecycle is already managed | Adding a task framework for simple SNS/EventBridge publishing. |
| SQS worker | SDK polling with cancellation, visibility renewal, deletion and backoff | Lambda event-source mapping for managed polling and scaling | A polling library inside event-source-mapped Lambda; no independently verified Go worker wrapper is recommended. |
| CloudEvents | Application-owned envelope when interoperability is unnecessary | `github.com/cloudevents/sdk-go/v2` `2` for CloudEvents contracts | An envelope standard presented as exactly-once delivery. |
| Idempotency | Database unique keys/transactions or DynamoDB conditional writes | Downstream idempotency token where supported | Check-then-write deduplication, invocation IDs as business keys, or a cache as the durable ledger. |

## Rules

- Scope deduplication to principal and operation, with payload mismatch and expiry rules. Model in-progress/completed outcomes; TTL is cleanup, not proof of exclusive ownership.
- Acknowledge after the durable effect succeeds. Test poison records, redelivery, visibility expiry, shutdown and FIFO ordering.
- Extract message trace context; inject it when publishing. Use an outbox when database writes and event publication must agree.
- Configure bounded retries, jitter and dead-letter handling. Middleware wraps processors; domain decisions remain in testable business functions.

## Sources

- [River](https://pkg.go.dev/github.com/riverqueue/river), [Asynq](https://pkg.go.dev/github.com/hibiken/asynq), [Temporal](https://pkg.go.dev/go.temporal.io/sdk), [Lambda durable SDK](https://github.com/aws/aws-durable-execution-sdk-go/releases/tag/v1.0.0).
- [cron](https://pkg.go.dev/github.com/robfig/cron/v3), [gocron](https://pkg.go.dev/github.com/go-co-op/gocron/v2), [franz-go](https://pkg.go.dev/github.com/twmb/franz-go), [Sarama](https://pkg.go.dev/github.com/IBM/sarama), [Confluent](https://pkg.go.dev/github.com/confluentinc/confluent-kafka-go/v2).
- [RabbitMQ](https://pkg.go.dev/github.com/rabbitmq/amqp091-go), [NATS JetStream](https://github.com/nats-io/nats.go/blob/main/jetstream/README.md), [Watermill](https://pkg.go.dev/github.com/ThreeDotsLabs/watermill), [CloudEvents](https://pkg.go.dev/github.com/cloudevents/sdk-go/v2).
- [SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html), [Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html), [EventBridge bindings](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-schema-code-bindings.html).
