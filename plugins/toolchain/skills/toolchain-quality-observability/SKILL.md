---
name: toolchain-quality-observability
description: Use when adding logging, tracing, metrics, or quality and security scanners to a service, worker or CI.
metadata:
  opencode/autoinvoke: false
---

# Quality and observability defaults

Checked 2026-11-12.

## Observability

OpenTelemetry is the default for new services, workers, network-calling CLIs and Lambda functions: traces and metrics through the OTel SDK, OTLP to a Collector, and structured JSON logs that carry `trace_id` and `span_id`. Existing projects keep their stack unless the task is a migration.

- Rules for setup, export, sampling, flushing, naming, cardinality, privacy and telemetry tests: `quality-code-design`'s `telemetry.md`.
- SDK packages, bootstrap and signal stability per language: `lang-<language>-libraries`, `references/observability.md`.
- Lambda in Python, TypeScript, Java and .NET: the ADOT/Application Signals layer for traces with Powertools Logger and Metrics, without Powertools Tracer. Go and Rust: the runtime library, a structured logger, manual OTel and the Collector extension (`aws-guidance`).

## Quality and security scanners

Choose scanners by capability, one tool per gate, and run what the project can run both locally and in CI.

| Gate | Default | Notes |
| --- | --- | --- |
| Secrets | Offline Betterleaks or Gitleaks on changed content in the pre-commit hook; TruffleHog over history in CI; GitHub push protection where available | Verified-only results miss secrets that cannot be verified; review unverified findings |
| Dependency vulnerabilities | The ecosystem's audit: `uv audit` (preview) or `pip-audit`, `bun audit` or `npm audit`, pinned `govulncheck`, `cargo-deny` | OSV-Scanner v2 only where it adds coverage, such as several ecosystems in one repository. One updater (Renovate or Dependabot) with a cooldown |
| Static analysis | The language's security lint (Ruff `S`, `gosec`, Clippy); Semgrep CE or Opengrep for custom rules; CodeQL in CI for supported languages | Semgrep-maintained rules carry a restrictive licence since 2024-12-13; the engines stay LGPL-2.1 |
| Dead code | Vulture (Python), Knip 6 (TypeScript), Go `deadcode` beside `unused`, `cargo-machete` (Rust) | Start at high confidence; dynamic code yields false positives |
| Duplication and complexity | The linter's native complexity check (Ruff `C901`, `gocyclo`/`gocognit`); `jscpd` as a report | Ratchet existing exceptions. Do not gate on Clippy `cognitive_complexity`: it is an allow-by-default restriction lint whose docs say it does not measure cognitive complexity. Gate Rust on `too_many_lines` and `too_many_arguments` with review |
| Containers and IaC | Every built image is scanned on each release and on a schedule: Grype with a Syft SBOM by default, or Trivy pinned by digest with verified signatures. Hadolint for Dockerfiles; one IaC scanner (Checkov or KICS) and TFLint where IaC exists | Trivy binaries, images and actions were compromised in March 2026, so it runs only from verified, pinned artifacts; tfsec now points to Trivy |
| CI workflows | `zizmor`, `actionlint`, `pinact`; `harden-runner` where egress monitoring is wanted | See `ci-github-actions` |
| SBOM, licences, provenance | Syft or cdxgen (CycloneDX or SPDX); a dependency licence inventory; trusted publishing with npm provenance or PyPI attestations | An SBOM lists components; pair it with a vulnerability scan |

Every suppression names an owner and an expiry. Rescan on a schedule as well as on pull requests. Commands per language are in the `lang-<language>-quality` skills; repository wiring is in `project-scaffold`'s `ci-hooks.md`.
