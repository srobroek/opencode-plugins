# Messaging and background work

Choose durable job, workflow and broker clients, with explicit delivery and retry semantics.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Redis-backed jobs | `bullmq` `6` | `pg-boss` `12` when PostgreSQL is the existing durable store. | New Redis deployment for a few jobs already suited to the database; assuming exactly-once effects. |
| Existing PostgreSQL/managed jobs | `pg-boss` `12` for a new PostgreSQL-backed queue | `graphile-worker` `0.18` for its SQL job model; `inngest` `4` or `@trigger.dev/sdk` `4` for managed execution. | Introducing a managed platform without reviewing hosting/replay/operational constraints. |
| Durable workflows | `@temporalio/client` `1`, matching worker/workflow packages | Existing managed workflow system when hosting and operations are already decided. | Timer loops or queue chains to recreate durable workflow state; assuming native worker support on Bun. |
| In-process scheduling | `croner` `11` | Bun built-in cron for intentionally Bun-only, tested deployments. | In-process cron for singleton durable schedules across replicas or sleeping Lambda. |
| Job schedules | BullMQ Job Schedulers in `bullmq` `6` | EventBridge Scheduler via AWS SDK `3` for managed AWS schedules. | Old repeatable-job APIs for new scheduler designs; local timezone/DST assumptions. |
| Kafka/MSK | `@confluentinc/kafka-javascript` `1` on supported Node targets | `kafkajs` `2` when pure-JS constraints matter and maintenance has an owner; last observed push was `2024-08-02`, not archived. | Assuming native librdkafka support on Bun; fresh KafkaJS adoption without maintenance ownership. |
| RabbitMQ | `rabbitmq-client` `5` for managed connections | `amqplib` `2` for low-level control/existing integrations. | Acknowledging before durable effects; unbounded prefetch; treating retries as free. |
| NATS | `@nats-io/transport-node` `3` with its matching packages | Existing WebSocket transport when browser/runtime constraints require it. | Confusing ephemeral core NATS delivery with durable JetStream semantics. |
| SQS/SNS/EventBridge | `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, `@aws-sdk/client-eventbridge` `3` | Lambda event-source mappings with Powertools Batch `2`; a consumer library for a real long-running polling lifecycle. | Handwritten Lambda polling; batch failure handling that retries successful records. |
| CloudEvents | `cloudevents` `10` when the event contract uses CloudEvents | Existing AsyncAPI envelope when compatibility wins. | Treating an envelope specification as broker delivery guarantees. |
| Idempotency | Powertools Idempotency `2` on Lambda; transactional uniqueness/outbox in services | Broker deduplication as an additional bounded-window safeguard. | Check-then-write races; retries of payments/email without an effect key and persistence policy. |

## Rules

- Workers accept bounded concurrency, deadlines and shutdown cancellation. Stop intake
  before draining; make acknowledgement contingent on successful durable work.
- BullMQ uses processors/events, not a generic onion middleware stack. Wrap processors
  deliberately for shared policy. Bun cron registers OS-level jobs and uses local time;
  it is not a portable durable queue scheduler.
- Separate retryable failures from permanent ones. Bound attempts, apply jitter, publish
  failed work to the chosen dead-letter path, and expose age/backlog/failure metrics.
- Use the same event identity for replay and deduplication. Propagate trace context in
  message metadata; use links for batch/fan-in where one parent is misleading.
- Test broker reconnection and native dependencies on Bun; Node SDK availability alone
  does not establish Bun worker support. See `backend-background-jobs` for job design.

## Sources

- [BullMQ schedulers](https://docs.bullmq.io/guide/job-schedulers), [pg-boss](https://github.com/timgit/pg-boss), [Temporal TypeScript](https://docs.temporal.io/develop/typescript).
- [Confluent JavaScript](https://github.com/confluentinc/confluent-kafka-javascript), [RabbitMQ acknowledgements](https://www.rabbitmq.com/docs/confirms), [NATS](https://github.com/nats-io/nats.js).
- [Powertools Batch](https://docs.aws.amazon.com/powertools/typescript/latest/features/batch/), [CloudEvents SDK](https://github.com/cloudevents/sdk-javascript).
- [Registry metadata](https://registry.npmjs.org/).
