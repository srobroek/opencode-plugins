---
name: toolchain-quality-observability
description: Use when adding logging, tracing, or security scanners to a service or worker.
---

# Quality And Observability Defaults

Use structured logging for services and workers. Add OpenTelemetry when a
runtime boundary, distributed workflow, or production operation needs traceable
behavior.

Use security scanners conditionally. Prefer checks that the project can run
locally and in CI without creating noisy false positives.
