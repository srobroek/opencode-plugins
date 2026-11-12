# Messaging and background work

Use broker clients and workflow engines for their delivery semantics, not as interchangeable task runners.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Ordinary jobs | `apalis` `1.1` | Existing broker/worker conventions already persist jobs and retry failures | An in-process task mistaken for durable work. |
| Durable workflows | `temporalio-sdk` `1.2` | `apalis` `1.1` for independent jobs without workflow history | Nondeterministic workflow code; assuming all Rust SDK features are stable or that GA was verified. |
| Ruby Sidekiq integration | `sidekiq` `0.14` as producer | `apalis` `1.1` for Rust workers | Treating the Sidekiq crate's documented client as a Rust worker framework. |
| Process scheduling | `tokio-cron-scheduler` `0.15` | `croner` `4` for cron parsing/evaluation; platform scheduler for distributed execution | Assuming local scheduling guarantees one execution across replicas. |
| Kafka/MSK | `rdkafka` `0.39` | `rskafka` `0.6` for partition/WAL-oriented requirements without groups/transactions | Assuming `rskafka` supplies groups, transactions or offset tracking; ignoring native librdkafka packaging. |
| RabbitMQ/AMQP | `lapin` `4.12` | Existing service uses another broker | Acknowledging before durable business effects; unbounded prefetch. |
| NATS/JetStream | `async-nats` `0.52` | Existing Kafka/AMQP ecosystem wins | Assuming core NATS and JetStream have the same durability. |
| SQS/SNS/EventBridge | Service-specific `aws-sdk-*` `1` | `apalis` `1.1` adapter when it demonstrably handles the required worker lifecycle | Handwritten signing or envelope clients; assuming a send API is a worker framework. |
| Event envelopes | `cloudevents-sdk` `0.9` | Broker-native envelope required by an existing contract | CloudEvents mistaken for a broker or exactly-once guarantee. |
| Idempotency | Database transaction/unique key with `sqlx` `0.9`; DynamoDB conditional writes with SDK `1` | Existing durable idempotency utility proves its store and failure semantics | Check-then-write races; process caches used for durable deduplication. |

## Rules

- Keep processors thin, extract trace context at delivery, wrap cross-cutting behavior using the engine's middleware or an explicit processor wrapper.
- Bound concurrency, queues, retry counts and time budgets. Distinguish retryable failure from malformed poison records; arrange dead-letter handling.
- Commit business changes before acknowledging. Coordinate outbox publication with the transaction when database writes and events must agree.
- Scope deduplication by operation/principal and payload, persist completion, and define expiry/recovery. Partial batch failure is a separate concern from duplicate suppression.
- Use `toolchain-api` for AsyncAPI and event contracts. Use `quality-code-design`'s `middleware.md` and `telemetry.md` for shared design rules.

## Sources

- [Apalis](https://docs.rs/apalis/latest/apalis/), [Temporal Rust](https://docs.temporal.io/develop/rust), [Sidekiq client](https://docs.rs/sidekiq/latest/sidekiq/).
- [Kafka client](https://docs.rs/rdkafka/latest/rdkafka/), [Rskafka limitations](https://docs.rs/rskafka/latest/rskafka/), [Lapin](https://docs.rs/lapin/latest/lapin/), [NATS](https://docs.rs/async-nats/latest/async_nats/).
- [CloudEvents SDK](https://crates.io/crates/cloudevents-sdk), [AWS Rust SDK](https://github.com/awslabs/aws-sdk-rust), [Crate registry](https://crates.io/).
