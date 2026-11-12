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

Applications, services and CLIs use the OpenFeature client through that module,
with one provider over the backend chosen below. If no maintained provider exists
for the backend in that language, stop and ask before writing one; never silently
substitute a backend wrapper. Review third-party providers as dependencies.
A provider swap keeps the API; targeting, bucketing and analytics need separate
migration checks. Verify context mappings and behavior before migration.

**Exception:** OpenCode plugins keep plugin options: the host config is their backend.
Libraries take decisions from their caller and never evaluate flags.

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
**Do not:** promise instant fleet changes. Check provider retrieval and cache behavior.

AppConfig Agent, including its Lambda extension, polls every 45 seconds by default
and serves the cached value when a refresh times out (checked 2026-11-12).
Choose a poll interval and staleness budget that meet the kill switch's response time.

## Choose the backend by need

| Need | Store | Who owns the definition |
| --- | --- | --- |
| Local development, CLIs, services outside AWS, or flags changed with a deploy | Repository `flags.yaml` in flagd format | Code/config owner, reviewed in Git |
| Simple runtime on/off toggles on AWS without staged rollout | SSM Parameter Store | IaC resources; audited operator values |
| Kill switches, gradual or percentage rollout | AppConfig feature flag profile through the Agent | Reviewed deployments with validators, strategies and alarm rollback |

Entitlements and tenant permissions stay in the domain database, for example
DynamoDB; they are not flags. Keep an existing repository flag service. Adding a
hosted flag service needs approval. Experiments need exposure and outcome metrics;
choosing an experiment platform needs approval. An SDK is not statistics.

**Do:** let IaC (`CDK` or `Terraform`) own applications, environments, profiles,
validators, deployment strategies and IAM. Say who changes live values, retain an
audit trail and separate production from development. Reconcile emergency changes
explicitly before the next apply.
**Do not:** let IaC silently overwrite an emergency change or put secrets in payloads.

CloudWatch Evidently was discontinued in October 2025; use AppConfig. AWS's API
notice says October 16 and its announcement says October 17 (checked 2026-11-12).
See `aws-guidance` for prices, quotas and the distinction between native AppConfig
flags and Python Powertools Feature Flags' freeform rules. Do not stack rule engines.

## flags.yaml

Use the flagd flag-definition format: top-level `flags`, each with `state`
(`ENABLED` or `DISABLED`), same-typed `variants`, an explicit `defaultVariant`,
and optional JsonLogic `targeting` that returns a variant name.

```yaml
$schema: https://flagd.dev/schema/v0/flags.json
flags:
  new-ui:
    state: ENABLED
    variants: {"on": true, "off": false}
    defaultVariant: "off"
```

Node and Rust file providers accept JSON only. Generate `flags.json` from
`flags.yaml` during the build and check for drift; do not maintain two definitions.
Offline flagd file providers poll every 5 seconds by default.

## Providers

Provider facts checked 2026-11-12. "Ask first" means no maintained provider was
found: stop and ask the user before writing one, not a silent wrapper fallback.

| Language | flags.yaml | SSM | AppConfig |
| --- | --- | --- | --- |
| Python | `openfeature-provider-flagd` `0.6`, `ResolverType.FILE`, `offline_flag_source_path`; YAML requires `.yaml` | `openfeature-provider-aws-ssm` `0.1` (contrib); set TTL cache, default LRU has no timed refresh | Ask first; provider would read Agent HTTP |
| TypeScript (Node) | `@openfeature/flagd-provider` `0.18`, in-process, `offlineFlagSourcePath`; generated JSON | `@openfeature/aws-ssm-provider` `0.1`; cache off by default, only boolean/string results cached | Ask first |
| Go | Contrib `providers/flagd` `0.8`, `WithOfflineFilePath`; `.yaml`, `.yml`, `.json` | Contrib `providers/aws-ssm` `1.0`; `GetParameter` every evaluation, no cache, shared 40 TPS default; evaluate once per request; object flags return default | Third-party `github.com/Arthur1/openfeature-provider-go-aws-appconfig` `0.4`; Agent only, boolean flags; dependency review required |
| Rust | `open-feature-flagd` `0.3`, file resolver; generated JSON | Ask first | Ask first |
| Browser | No local file; evaluate on server and send decisions, or ask first | Same | Same; never expose AWS credentials or Agent |

An approved custom provider uses `FLAG_NOT_FOUND`, `TYPE_MISMATCH`, `PARSE_ERROR`
and `GENERAL`, never a silent false. The Agent endpoint is
`http://localhost:2772/applications/<app>/environments/<env>/configurations/<profile>`;
use `?flag=<key>` for one flag and `Context: key=value` headers for multi-variant evaluation.

## Test decisions and failures

**Do:** test default and new states, plus named interactions, not every combination.
Test the outage default, missing key, wrong type and stale-cache boundary. Use the
SDK's in-memory provider or inject the decision; do not require a backend in unit tests.
Python uses `InMemoryProvider` from `openfeature.provider.in_memory_provider`, JS
uses the SDK's `InMemoryProvider`, and Go uses `memprovider.NewInMemoryProvider`.
Rust `0.3` has no shipped in-memory provider; use `MockFeatureProvider` with `test-util`.
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
- flagd definitions and file providers: https://flagd.dev/reference/flag-definitions/ and https://flagd.dev/providers/
- Rust SDK and error handling: https://openfeature.dev/docs/reference/sdks/server/rust/
- Provider portability limits: https://docs.growthbook.io/lib/openfeature
- AppConfig Agent: https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-agent-how-to-use.html
- Lambda caching: https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions-config.html
- AWS pricing: https://aws.amazon.com/systems-manager/pricing/
- Evaluation events: https://opentelemetry.io/docs/specs/semconv/feature-flags/feature-flags-events
- Deprecated attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/feature-flag
- Removal tooling: https://github.com/uber/piranha/blob/master/README.md
