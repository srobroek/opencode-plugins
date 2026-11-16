# Shared tools

Checked 2026-11-16.

Tools that work the same in every language. A language's `## Concerns` table points here
with `Shared: <id>`. [concerns.md](concerns.md) defines the concerns and the install policy:
detect the tool, recommend the install, and ask the user before you run it. The Maintenance
cell is a minimum version. Use the latest release the manager offers and record the
version you used. `Family` marks a tool with one binding per language, listed in its section;
`Service` marks a hosted service without releases.

## Tools

| Id | Tool | Concerns | Maintenance | Run | Use with |
|---|---|---|---|---|---|
| testcontainers | Testcontainers | integration | Family: [Testcontainers](#testcontainers) | every-pr | pact |
| contracts | Contract gate per API style | contract | Family: [Contracts by API style](#contracts-by-api-style) | every-pr + scheduled | pact, oasdiff, schemathesis |
| pact | Pact (required for significant internal service-to-service traffic) | contract | Family: [Pact with containers](#pact-with-containers) | every-pr | testcontainers, oasdiff |
| buf | Buf CLI | contract | >= 1.75.0 · 2026-10-22 · active | every-pr | pact |
| graphql-inspector | GraphQL Inspector | contract | >= 7.0.4 · 2026-11-13 · active | every-pr | - |
| asyncapi-cli | AsyncAPI CLI | contract | >= 6.3.1 · 2026-11-16 · active | every-pr | pact |
| schemathesis | Schemathesis | api-schema | >= 4.33.4 · 2026-11-12 · active | bounded-pr + scheduled | oasdiff, hurl |
| hurl | Hurl | integration | >= 8.1.0 · 2026-10-28 · active | every-pr | schemathesis |
| oasdiff | oasdiff | api-break, contract | >= 1.38.0 · 2026-11-14 · active | every-pr | schemathesis |
| k6 | k6 | load | >= 2.4.0 · 2026-11-12 · active | scheduled | - |
| osv-scanner | OSV-Scanner | dep-audit | >= 2.7.1 · 2026-11-09 · active | every-pr + scheduled | - |
| oss-fuzz | OSS-Fuzz | fuzz-continuous | Service: open-source projects only | scheduled | clusterfuzzlite |
| clusterfuzzlite | ClusterFuzzLite | fuzz, fuzz-continuous | >= v1 · 2026-02-12 · maintenance | bounded-pr + scheduled | oss-fuzz |
| semgrep | Semgrep CE | sast | >= 1.185.0 · 2026-11-10 · active | every-pr | codeql |
| opengrep | Opengrep | sast | >= 2.0.0 · 2026-11-13 · active | every-pr | codeql |
| codeql | CodeQL CLI | sast | >= 2.27.4 · 2026-11-02 · active | every-pr + scheduled | semgrep, opengrep |
| lizard | Lizard | complexity | >= 1.26.0 · 2026-11-10 · active | every-pr | - |
| jscpd | jscpd | duplication | >= 5.4.3 · 2026-11-08 · active | every-pr | - |
| gitleaks | Gitleaks | sast | >= 8.30.1 · 2026-03-21 · active | every-pr | - |

Pick one SAST engine as the default (`semgrep` or `opengrep`); `codeql` adds depth in CI for
the languages it supports. `gitleaks` covers secrets only, so it never replaces a language's
code scanner.

## Install

Detect first, then recommend, then ask. Prefer the project's manager (dev dependency, then
`mise.toml`) over a global install. Commands are starting points; check the tool's current
install page.

| Id | Detect | Install |
| --- | --- | --- |
| `testcontainers` | A Docker-API daemon: `docker info` | The language library, see [Testcontainers](#testcontainers) |
| `contracts` | The style's gate from [Contracts by API style](#contracts-by-api-style) | Install that gate's tool |
| `pact` | The language library in the manifest | The language library, see [Pact with containers](#pact-with-containers) |
| `buf` | `buf --version` | `brew install bufbuild/buf/buf` |
| `graphql-inspector` | `node_modules/.bin/graphql-inspector --version` | A dev dependency: `npm install --save-dev @graphql-inspector/cli` |
| `asyncapi-cli` | `node_modules/.bin/asyncapi --version` | A dev dependency: `npm install --save-dev @asyncapi/cli` |
| `schemathesis` | `schemathesis --version` | `uv tool install schemathesis` |
| `hurl` | `hurl --version` | `brew install hurl` |
| `oasdiff` | `oasdiff --version` | `brew install oasdiff` |
| `k6` | `k6 version` | `brew install k6` |
| `osv-scanner` | `osv-scanner --version` | `brew install osv-scanner` |
| `oss-fuzz` | No local tool | Open an onboarding PR to `google/oss-fuzz`; open-source projects only |
| `clusterfuzzlite` | `.clusterfuzzlite/` in the repository | Add the `google/clusterfuzzlite` actions to the workflow, pinned by commit SHA (see `ci-github-actions`) |
| `semgrep` | `semgrep --version` | `uv tool install semgrep` |
| `opengrep` | `opengrep --version` | Download the release binary from the Opengrep GitHub releases and verify its checksum |
| `codeql` | `codeql version` | In CI, the `github/codeql-action` pinned by SHA; locally, the CodeQL CLI bundle from GitHub releases |
| `lizard` | `lizard --version` | `uv tool install lizard` |
| `jscpd` | `node_modules/.bin/jscpd --version` | A dev dependency: `npm install --save-dev jscpd` (or the project's package manager) |
| `gitleaks` | `gitleaks version` | `brew install gitleaks` |

Run Schemathesis only against a disposable environment, never production. Run k6 only against
an environment sized and approved for the load.

## Tradeoffs

### sast

- **Semgrep CE**: wins when you write custom rules and want a fast local run; costs a
  restrictive licence on Semgrep-maintained rules since 2024-12-13 (the engine stays LGPL-2.1),
  so write or vendor your own rules.
- **Opengrep**: wins when you want the same rule format from a community fork with no vendor
  rule licence; costs a younger project and a smaller rule set.
- **CodeQL**: wins when you need data-flow analysis in CI for a supported language; free for
  open source and under GitHub's terms, but it needs a build for compiled languages and is slower.

Default to Semgrep CE or Opengrep with project-owned rules; add CodeQL in CI where the
repository is eligible.

### load

- **k6**: wins when you script scenarios in JavaScript with thresholds as pass/fail gates;
  costs AGPL-3.0: running it is fine, embedding or modifying it is copyleft.
- **Locust**: wins when the team writes Python and needs complex user behaviour; costs more
  load-generator CPU per virtual user.
- **oha**: wins for a quick HTTP rate or latency check; costs no scenarios or thresholds.
- **Vegeta**: wins for constant-rate HTTP attacks and Go libraries; costs a maintenance pace
  that has slowed (last release 2025-10-31).
- **Artillery**: wins when YAML scenarios and Playwright-driven browser load matter (MPL-2.0);
  costs a Node runtime.
- **Gatling**: wins when the team runs JVM tooling and wants detailed reports; costs a JVM
  and a heavier setup.

### contract

- **Schema gates per API style** (default): win when you own the schema and want a breaking
  change to fail the PR: oasdiff and Schemathesis for HTTP, `buf breaking` for protobuf,
  GraphQL Inspector for GraphQL, a registry compatibility mode for events; cost no record of
  what each consumer actually uses.
- **Pact**: wins, and is required, when two or more services you own call each other and deploy
  independently (see [Contracts by API style](#contracts-by-api-style)); costs consumer tests
  and a self-hosted Pact Broker. Not for public or third-party consumers, which you cannot ask
  to write pacts.
- **Specmatic**: wins when OpenAPI is the single source of truth and you want contract tests
  from the spec (MIT; where the commercial boundary starts is unverified); costs a spec-first workflow.
- **PactFlow bi-directional**: wins when you already have provider specs and consumer mocks
  and want hosted comparison; costs a paid SaaS (unverified) and a weaker guarantee than a
  verified pact.

### fuzz-continuous

- **OSS-Fuzz**: wins for an open-source project that wants Google-run, long campaigns with
  bug reports and a vulnerability disclosure flow; costs onboarding review and open source only.
- **ClusterFuzzLite**: wins for private repositories and PR-time fuzzing; costs your own CI
  minutes, slower corpus handling, and no JavaScript support.

### dep-audit

- **OSV-Scanner**: wins as one scanner across many lockfiles and ecosystems; costs less
  fixed-version guidance than an ecosystem's own audit.
- **Grype**: wins when you scan container images and SBOMs, usually with Syft; costs a
  separate database and a second tool for lockfile-only repositories.
- **Trivy**: wins on breadth (images, IaC, licences) in one binary; costs the March 2026
  compromise: use it only from verified artifacts pinned by digest (see
  `toolchain-quality-observability`).

## Contracts by API style

Default (option A): a schema gate per API style, run on every PR. Add Pact (option B) where the
condition below holds. Database migrations are persistence, not contracts: gate them with
squawk, Atlas or pgroll.

| Style | Default gate | Required add-on | Optional | Run |
|---|---|---|---|---|
| HTTP/OpenAPI | `oasdiff` for spec breaks against the base branch; Schemathesis for conformance, never against production | Pact consumer-driven contracts, Pact Broker and `can-i-deploy` when significant internal services call each other | Specmatic; PactFlow bi-directional (paid) | oasdiff every-pr; Schemathesis bounded-pr + scheduled |
| gRPC, protobuf, Connect | `buf breaking --against '.git#branch=main'` and `buf lint` | Pact with `pact-protobuf-plugin` 0.8.1 (pre-1.0) for internal gRPC between your own services | `connectrpc/conformance` 1.0.7, only when you implement a Connect or gRPC server or library | every-pr |
| GraphQL | `graphql-inspector diff` | - | GraphQL Hive 15.3.0 (MIT, self-hostable registry with usage data); Apollo Rover only for an existing GraphOS | every-pr |
| Events (Kafka, SNS/SQS, EventBridge) | Schema-registry compatibility mode `BACKWARD` or `FULL` (transitive when consumers lag), plus AsyncAPI 3.1 checked with `asyncapi validate` | Pact V4 message pacts for internal producer and consumer pairs you own | CloudEvents 1.0 envelope | every-pr |
| Webhooks | Payload described in OpenAPI `webhooks` or AsyncAPI, gated by the same diff; Standard Webhooks 1.0.2 tests for signature, replay (stale timestamp), key rotation and deduplication | - | - | every-pr |
| MCP servers | Committed snapshot of `tools/list` (names, input and output JSON Schemas), diffed in CI; a removed or tightened tool is breaking | - | MCP Inspector 2.15.0 for smoke tests only (licence moving from MIT to Apache-2.0) | every-pr |

Registries for events: Apicurio Registry 3.3.4 (Apache-2.0) is the open default; Confluent
Schema Registry is under the Confluent Community License; AWS Glue Schema Registry suits an
AWS-only stack. SNS, SQS and EventBridge have no registry gate, so diff the JSON Schema in CI.

### When Pact is required

Pact is required when two or more services you own call each other over HTTP, gRPC or messages
and deploy independently. Then:

1. Run a self-hosted Pact Broker (compose in [Pact with containers](#pact-with-containers)).
2. Publish pacts with the branch and the git SHA as the version.
3. Verify with the `mainBranch`, `matchingBranch` and `deployedOrReleased` selectors; enable
   pending and work-in-progress (WIP) pacts so a new consumer test never breaks the provider build.
4. Let broker webhooks trigger provider verification when a pact changes.
5. Run `can-i-deploy` before each deploy and `record-deployment` after it.

Public or third-party consumers get schema gates only: you cannot make them publish pacts.

## Testcontainers

Real dependencies in disposable containers for integration tests: databases, brokers, object
stores, provider images. Each language's `integration` row names it as `Shared: testcontainers`.

| Language | Package | Minimum | Licence |
| --- | --- | --- | --- |
| TypeScript | `testcontainers` (npm) | 12.2.1 | MIT |
| Python | `testcontainers` (PyPI) | 4.15.0 | Apache-2.0 |
| Go | `github.com/testcontainers/testcontainers-go` | 0.45.0 | MIT |
| Rust | `testcontainers` (crates.io) | 0.28.0 | Apache-2.0 |
| Java and Kotlin | `org.testcontainers` | 2.0.5 | MIT |
| .NET | `Testcontainers` (NuGet) | 4.16.0 | MIT |
| PHP | `testcontainers/testcontainers` (Packagist) | 1.2.1 | MIT |
| Ruby | `testcontainers` (RubyGems; tagged releases only) | 0.2.0 | MIT |

Rules:

- Any Docker-API daemon works: Docker, Podman, Colima or OrbStack. Point the library at it with
  `DOCKER_HOST` (and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` where the socket is mounted into
  the Ryuk container). Detect with `docker info`.
- Ryuk, the reaper container, removes containers after a crash. Keep it on; disable it only in
  a sandbox that forbids the mount, and then clean up in the test teardown.
- Container reuse is opt-in per developer machine, never in CI: it keeps state between runs and hides ordering bugs.
- Wait on a readiness check (log line, port or health check), read the mapped port from the
  container, and never hard-code a host port.
- Use compose or CI service containers instead when the stack is long-lived, shared by many
  test processes, or already the project's dev environment. Use Testcontainers when each
  test run needs its own isolated, programmatically configured dependency.
- Prefer a Linux-only CI runner with Docker for these tests; mark them so a run without Docker
  reports "not run", never a pass.

## Pact with containers

1. **Consumer test.** Use the library's in-process mock server; it writes pacts to `./pacts`.
   Clear that directory first and run stateful consumer tests serially.
2. **Publish.** `pact-broker publish ./pacts --consumer-app-version $GIT_SHA --branch $BRANCH`,
   run from the `pactfoundation/pact-cli` image (image name unverified). Pass the broker token
   through the environment (`fnox exec`), never on the command line.
3. **Provider verification.** Start the provider image with Testcontainers, wait on its health
   check, read the mapped port and point the verifier at it (`providerBaseUrl`, or
   `pact_verifier_cli --provider-base-url`). Handle provider states over an HTTP callback and
   seed a Testcontainers Postgres on the same network. Select consumer versions with
   `mainBranch`, `matchingBranch` and `deployedOrReleased`. Publish verification results from
   CI only, with the provider version set to the git SHA.
4. **Deploy gate.** `pact-broker can-i-deploy --pacticipant X --version $SHA --to-environment prod`,
   then `record-deployment` after the release.
5. **Stub.** `pactfoundation/pact-stub-server --dir /pacts --port 8080` stands in for a
   provider in consumer integration tests. It never replaces verification.
6. **Messages and gRPC.** Use V4 asynchronous message pacts for Kafka-style flows. For gRPC,
   install the `pact-protobuf-plugin` (0.8.1, 2026-10-05) in the CI image.

Library minimums:

| Language | Package | Minimum | Note |
| --- | --- | --- | --- |
| TypeScript | `@pact-foundation/pact` | 17.1.4 | Node 22 or later, glibc; Alpine unsupported; run under Node (Bun unverified) |
| Python | `pact-python` | 4.2.0 | - |
| Go | `github.com/pact-foundation/pact-go/v2` | 2.9.0 | - |
| Java and Kotlin | `au.com.dius.pact` (pact-jvm) | 4.7.7 | - |
| .NET | `PactNet` | 5.0.1 | - |
| Rust | `pact_consumer`, `pact_verifier` | pact_verifier 1.6.0 | `pact_ffi` 0.5.13 backs other bindings |

Broker for a long-lived setup, in compose: `postgres:17` with a `pg_isready` health check, and
`pactfoundation/pact-broker` pinned by digest with `PACT_BROKER_DATABASE_URL`,
`PACT_BROKER_BASE_URL` and `PACT_BROKER_PORT=9292`. The heartbeat is
`/diagnostic/status/heartbeat`; a `wget` health check against it is unverified, so test it.
Set `PACT_BROKER_DATABASE_CLEAN_ENABLED=true` so old data is cleaned up.

## Mutation reports

Mutation tools emit the mutation-testing-report-schema
(`stryker-mutator/mutation-testing-elements` 3.9.0, 2026-07-27), which `quality_test_compare` reads.

| Tool | Schema output | Minimum |
| --- | --- | --- |
| Stryker (JavaScript, TypeScript) | Native | 10.1.1 |
| Stryker.NET | Native | 5.1.0 |
| Stryker4s | Native | 1.1.1 |
| Infection (PHP) | Native | 0.35.11 |
| PIT (JVM) | Third-party `pitest-mutation-testing-elements-plugin` 0.7.1 | PIT 1.30.2 |
| cosmic-ray (Python) | Third-party `cosmic-ray-to-mutation-elements-adapter` 1.0.1 | - |
| mutmut (Python) | None | 3.8.1 |
| cargo-mutants (Rust) | None; writes `outcomes.json` | 27.1.0 |
| Gremlins (Go) | None; writes JSON | 0.6.0 |

`quality_test_compare` reads the schema, cargo-mutants `outcomes.json` and the Gremlins JSON.
For mutmut, convert the result or read its own output; do not compare scores across tools,
because each tool's mutators differ.

## Continuous fuzzing

| Language | OSS-Fuzz | ClusterFuzzLite | Engine |
| --- | --- | --- | --- |
| C and C++ | Yes | Yes | libFuzzer, AFL++ |
| Go | Yes | Yes | Native Go fuzzing |
| JavaScript and TypeScript | Yes | No | Jazzer.js |
| JVM (Java, Kotlin) | Yes | Yes | Jazzer |
| Python | Yes | Yes | Atheris |
| Rust | Yes | Yes | cargo-fuzz |
| Swift | Yes | Yes | libFuzzer |

ClusterFuzzLite runs in code-change mode on pull requests (the `fuzz` concern, with a time
bound) and in batch mode on a schedule (the `fuzz-continuous` concern). Languages missing from
the table report both concerns as not run, or use the language's own fuzzer on a schedule.
