# Python messaging

Choose durable job execution, scheduling and broker clients, with explicit retry and acknowledgment semantics.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Distributed jobs | `dramatiq` `2` | `celery` `5` for broader scheduling/workflow ecosystem; `rq` `3` for simple Redis jobs | In-process background tasks for durable work; untrusted pickle payloads |
| Async jobs | Existing queue; `taskiq` `0.13` when asyncio-native tasks are required | `arq` `0.28` for small Redis-based async queues | Assuming async queues execute only once; arq explicitly permits repeats |
| PostgreSQL queue | `procrastinate` `3` when an existing PostgreSQL service should own the queue | Dramatiq with existing broker operations | Adding a second broker without a requirement; queue side effects outside transaction design |
| Durable workflows | `temporalio` `1` | `hatchet-sdk` `1` for its platform; AWS workflow choices in `aws-guidance` | In-memory state machines as durable workflows; uncontrolled side effects during replay |
| In-process schedule | `APScheduler` `3` | Platform cron for independently operated jobs | APScheduler `4` is prerelease and explicitly not production-ready; scheduler per web worker duplicates jobs |
| Distributed periodic jobs | Platform scheduler dispatching durable jobs | `celery` `5` beat when already in that ecosystem | Multiple beat instances for one schedule; overlapping non-idempotent executions |
| Legacy scheduling | Keep existing scheduler only with ownership | Existing `rocketry` `2` deployment with accepted maintenance risk | New Rocketry adoption: stale release/push evidence, not an archival claim |
| Kafka | `confluent-kafka` `2` | `aiokafka` `0.15` for asyncio-oriented integration | Confluent's incompatible preview is not production-ready; cap the selected major |
| RabbitMQ | `aio-pika` `10` for async workers | Existing synchronous client for synchronous workers | Ack before durable effects; reconnect does not mean exactly-once |
| NATS | `nats-py` `2` | JetStream within the same client for persistence/replay | Core NATS when durable delivery is required |
| SQS/SNS/EventBridge | `boto3` `1` | `aiobotocore` `3`/`aioboto3` `15` for async I/O with compatible SDK pins | Blocking SDK on event loop; independent botocore upgrades |
| Lambda batches | `aws-lambda-powertools` `3` Batch Processing | Individual handlers for unsupported sources | Treating batch utility as universal SNS/EventBridge/S3 processing; missing partial-failure IaC |
| Event envelopes | `cloudevents` `2` when interoperating | Domain schemas alongside envelope; native AWS envelopes at AWS boundary | CloudEvents is not payload validation or exactly-once delivery; SDK warns of compatibility risk |
| Idempotency | Queue/framework policy; Powertools Idempotency on Lambda | Database constraints/atomic operation records with stable business keys for other workers | Check-then-write races; invocation IDs as operation keys; claiming exactly-once external effects |
| Consumer telemetry/policy | Dramatiq broker middleware; Celery lifecycle signals | Explicit processor wrappers for uncovered concerns | Assuming every queue offers an onion middleware engine |

## Rules

- Load `backend-background-jobs` for worker design. Define delivery semantics, visibility/lease time, backoff, maximum attempts, poison-record handling and dead-letter ownership.
- Acknowledge after durable work. Make repeats harmless with atomic in-progress/completed state, expiry and downstream idempotency tokens where supported.
- Extract trace context from messages and inject it on publishing. Test retries, cancellation, partial failures and shutdown before rolling out.
- Maintain one scheduling authority; scheduled dispatch is not durable execution. Give every workflow replay-safe side effects.

## Sources

- [Dramatiq](https://dramatiq.io/), [Celery periodic tasks](https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html), [Celery signals](https://docs.celeryq.dev/en/stable/userguide/signals.html)
- [arq semantics](https://arq-docs.helpmanual.io/), [Procrastinate](https://github.com/procrastinate-org/procrastinate), [Temporal SDK](https://github.com/temporalio/sdk-python)
- [APScheduler production warning](https://github.com/agronholm/apscheduler), [Rocketry metadata](https://api.github.com/repos/Miksus/rocketry)
- [Confluent migration warning](https://github.com/confluentinc/confluent-kafka-python), [aiokafka](https://aiokafka.readthedocs.io/), [aio-pika](https://docs.aio-pika.com/), [NATS](https://github.com/nats-io/nats.py)
- [SQS client](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/sqs.html), [CloudEvents SDK](https://github.com/cloudevents/sdk-python)
- [Powertools](https://docs.aws.amazon.com/powertools/python/latest/), [Package version registry](https://pypi.org/)
