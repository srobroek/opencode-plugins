# Feature flags: code and storage

Read when adding, evaluating, storing, rolling out or removing a feature flag.
The process lives in `trunk-dev-feature-flags`; AWS service specifics live in
`aws-guidance`; SDK packages live in `lang-<language>-libraries`, `runtime.md`
and `aws.md`. These rules are language-neutral. Facts checked 2026-11-12.

## Name the kind and lifetime

| Kind | Purpose | Lifetime |
| --- | --- | --- |
| Release | Hide incomplete work, then roll it out | Remove after rollout or abandonment |
| Experiment | Compare stable cohorts and measured outcomes | Remove after the decision |
| Operational kill switch | Stop a risky path without deploying | Temporary, or reviewed with a runbook |
| Permission | Restrict access to an already-authorized capability | Review while the restriction exists |

**Do:** keep entitlements, tenant permissions and authorization in domain data
and policy. A rollout flag may restrict an authorized capability, never grant one.
**Do not:** use a disposable flag as proof of paid access or security permission.
Permission here means an extra rollout restriction, not the source of authority.

Static configuration, secrets and build-time constants are not rollout flags.
Connection settings belong in config; secrets belong in secret storage. A build
constant requires a rebuild and cannot serve as a runtime kill switch.

## One flag module

**Do:** define typed keys, value types, defaults and metadata (owner, kind, expiry
or review date) in one module. Feature code calls that module, never environment,
config, SSM or AppConfig directly. Keep boolean and variant types explicit.
**Do not:** scatter string keys, backend reads or fallback values across callers.

Applications and services evaluate through the OpenFeature SDK when a maintained
provider exists. Otherwise the module wraps the backend behind the same
`isEnabled(key, context)` shape, with typed accessors for non-boolean values.
Writing a custom OpenFeature provider needs approval. Review third-party providers
as dependencies. A provider swap keeps the API. Targeting, bucketing and analytics
need separate migration checks. Verify context mappings and behavior before migration.

**Exception:** CLIs and OpenCode plugins use a local option or environment accessor.
Libraries accept the decision as an option from their caller and never fetch flags.
Do not add a remote dependency to make a local switch look like a service flag.

## Decide at the edge, inject the decision

The toggle router decides why a variant applies; the toggle point selects behavior.
**Do:** evaluate once per request or job at the boundary, after authentication.
Pass an immutable decision object or selected strategy into business code.
For a large replacement, branch by abstraction: select the implementation once.
**Do not:** evaluate in hot loops or nest flags. If an interaction is needed, name
the combined decision and test it explicitly.

Bad: each item in a batch fetches `new-pricing` and picks a different implementation.
Good: the job boundary selects one pricing strategy and passes it to the processor.

## Defaults and outages

**Do:** default a release flag to existing behavior, normally off. Choose the outage
default per flag; `false` is unsafe when the flag disables a protection. Record
whether failures serve last-known-good data or the fallback, and the maximum
acceptable staleness. Define what happens after that limit, not just a cache TTL.
**Do not:** assume every SDK or provider returns a supplied default on error.
The Rust SDK returns an error that the flag module maps to the chosen default.

Bad: backend failure sets `enforce-validation` to `false` and bypasses validation.
Good: the outage default preserves validation, with a visible fallback reason.

## Context and stable cohorts

**Do:** use an authenticated, stable targeting key. Bucket by tenant when everyone
in a tenant must see the same variant. Allowlist context fields and verify how the
provider maps them. Treat client-supplied tenant ids as untrusted until validated.
**Do not:** assign variants with per-request randomness or use secrets in context.
An experiment needs stable exposure attribution as well as an evaluation result.

## Initialization and caching

**Do:** initialize the client once, bound the startup wait, refresh in the background
and dispose background work on shutdown. Monitor readiness and cache age.
Test cold startup without a cache separately from refresh failure with a cache.
**Do not:** block every request on backend retrieval or promise instant fleet changes.

AppConfig Agent, including its Lambda extension, polls every 45 seconds by default
and serves the cached value when a refresh times out (checked 2026-11-12).
Choose a poll interval and staleness budget that meet the kill switch's response time.

## Choose storage by the need

| Need | Store | Who owns the definition |
| --- | --- | --- |
| Static per-environment setting | Config or env; SSM Parameter Store when it must be central | Code/config owner, Git or IaC |
| Runtime kill switch | AWS AppConfig feature flag profile through the Agent | IaC resources; audited operator values |
| Gradual or percentage rollout | AppConfig native flags through the Agent, or an existing managed platform | Reviewed rollout rules and deployments |
| Per-tenant/user overrides and entitlements | Domain database, for example DynamoDB; layer rollout separately | Application's domain-data workflow |
| Experiments with metrics | Experiment platform or hosted flag service | Product and engineering own hypothesis, exposure and metrics |
| Several teams or non-AWS | Hosted service with an OpenFeature provider, or `flagd` | Platform team; `flagd` needs an owned control plane |
| CLIs, libraries and plugins | Options or env; caller decisions for libraries | Code/config owner |

AppConfig provides validators, deployment strategies and alarm rollback. SSM is
a settings store, not the default rollout engine. `flagd` evaluates flags. Its team
must supply management and persistence. Validate experiment analytics; an SDK is not statistics.

**Do:** let IaC (`CDK` or `Terraform`) own applications, environments, profiles,
validators, deployment strategies and IAM. Say who changes live values, retain an
audit trail and separate production from development. Reconcile emergency changes
explicitly before the next apply.
**Do not:** let IaC silently overwrite an emergency change or put secrets in payloads.

CloudWatch Evidently was discontinued in October 2025; use AppConfig. AWS's API
notice says October 16 and its announcement says October 17 (checked 2026-11-12).
See `aws-guidance` for prices, quotas and the distinction between native AppConfig
flags and Python Powertools Feature Flags' freeform rules. Do not stack rule engines.

## Test decisions and failures

**Do:** test default and new states, plus named interactions, not every combination.
Test the outage default, missing key, wrong type and stale-cache boundary. Use the
SDK's in-memory provider or inject the decision; do not require a backend in unit tests.
**Do not:** test only the enabled branch or assume a missing key is always harmless.
Use the `quality-testing` skill for test level, doubles and integration coverage.

## Observe the rollout

**Do:** log evaluations or emit the OpenTelemetry `feature_flag.evaluation` event.
Use `feature_flag.key`, `feature_flag.result.value`, `feature_flag.result.variant`,
`feature_flag.result.reason`, `feature_flag.provider.name`, `feature_flag.version`
and `error.type` where available. The conventions are release candidate as of
2026-11-12; avoid deprecated `feature_flag.variant` and `feature_flag.evaluation.reason`.
Compare error, latency and business metrics by variant, and tie rollout to alarms.
**Do not:** use user ids as metric dimensions or log sensitive targeting context.
See [telemetry.md](telemetry.md) for setup, cardinality and privacy rules.

## Remove the flag and dead path together

**Do:** record owner, kind and expiry or review date for every flag. When rolled out
or abandoned, delete the dead branch, its tests and the definition in one change.
Long-lived kill switches get a review date and runbook. Uber `PolyglotPiranha` can
automate dead-branch removal; review its output and run the relevant tests.
**Do not:** leave permanent release flags or two implementations without an owner.

## Sources

- Toggle kinds and architecture: https://martinfowler.com/articles/feature-toggles.html
- OpenFeature evaluation: https://openfeature.dev/specification/sections/flag-evaluation/
- Rust SDK and error handling: https://openfeature.dev/docs/reference/sdks/server/rust/
- Provider portability limits: https://docs.growthbook.io/lib/openfeature
- AppConfig Agent: https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-agent-how-to-use.html
- Lambda caching: https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions-config.html
- AWS pricing: https://aws.amazon.com/systems-manager/pricing/
- Evaluation events: https://opentelemetry.io/docs/specs/semconv/feature-flags/feature-flags-events
- Deprecated attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/feature-flag
- Removal tooling: https://github.com/uber/piranha/blob/master/README.md
