# Kotlin testing and quality tooling

Kotlin has no language plugin yet. A project researches commands and versions before it adopts a tool here, and follows the install policy in [concerns.md](concerns.md): detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers. JVM tools shared with Java are in [java.md](java.md); shared tools are in [shared-tools.md](shared-tools.md).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `Kotest` | >= 6.2.7 · 2026-11-11 · active | `grep -rl kotest build.gradle.kts` · `testImplementation io.kotest:kotest-runner-junit5` | `JUnit Jupiter`: Java and Kotlin tests share one stock runner | Kotest and JUnit Jupiter in one module, since Kotest runs on the JUnit Platform | every-pr | Kotest 5 plugins and extensions on Kotest 6 without checking they were ported |
| `assertions` | `Kotest assertions` | >= 6.2.7 · 2026-11-11 · active | `grep -rl kotest-assertions build.gradle.kts` · `testImplementation io.kotest:kotest-assertions-core` | `AssertJ`: a mixed Java and Kotlin module that already uses it (3.27.7) | - | every-pr | Mixing Kotest matchers and AssertJ in one file |
| `watch` | Built-in: Gradle continuous build (`gradle test --continuous`) | - | Built-in | None | - | on-demand | Continuous builds on a task graph that includes slow integration tests |
| `property` | `Kotest property` | >= 6.2.7 · 2026-11-11 · active | `grep -rl kotest-property build.gradle.kts` · `testImplementation io.kotest:kotest-property` | `jqwik`: a JUnit Platform engine written for Java (1.10.2) | - | every-pr | Unseeded runs with no saved failing seed |
| `fuzz` | Inherits: java | - | Inherits | None | - | bounded-pr | Fuzz targets that keep state between calls |
| `fuzz-continuous` | Shared: clusterfuzzlite | - | Shared | `oss-fuzz`: an open-source project that wants Google-run campaigns | `clusterfuzzlite` on pull requests with `oss-fuzz` for long campaigns | scheduled | Discarding the corpus between runs |
| `mutation` | `PIT` | >= 1.30.2 · 2026-11-05 · active | `grep -rl pitest build.gradle.kts` · `Gradle plugin info.solidsoft.pitest` | `Arcmutate`: paid Kotlin mutators and filters that cut the noise | `PIT` with the Arcmutate Kotlin plugin when the budget allows | diff-pr + scheduled | Plain PIT on Kotlin without a review of the noisy survivors from compiler-generated code |
| `snapshot` | Inherits: java | - | Inherits | None | - | every-pr | Approving a golden file without reading it |
| `component` | N/A: Kotlin has no default UI component model | - | - | None | - | - | - |
| `concurrency` | Inherits: java | - | Inherits | None | - | scheduled | Sleeping to provoke a race; treating one passing run as proof |
| `coverage` | `Kover` | >= 0.9.11 · 2026-09-29 · active | `grep -rl kover build.gradle.kts` · `Gradle org.jetbrains.kotlinx.kover plugin` | `JaCoCo`: Maven builds and existing JaCoCo reports | - | every-pr | Coverage thresholds as the goal; inline functions and generated code left in the report |
| `benchmark` | Inherits: java | - | Inherits | None | - | on-demand | Benchmarks without warm-up forks |
| `flaky-order` | Built-in: Kotest `specExecutionOrder = Random` and JUnit random orderers | - | Built-in | None | - | scheduled | Retries that hide a flake without an owner |
| `integration` | Shared: testcontainers | - | Shared | None | - | every-pr | Mocked databases standing in for the real engine |
| `contract` | Shared: contracts | - | Shared | `Pact JVM`: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Verifying a provider only against a mock |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr | Running against production |
| `load` | Shared: k6 | - | Shared | `Gatling`: a JVM team that writes scenarios in code | - | scheduled | Load tests against an environment not sized for them |
| `lint` | `detekt` | >= 1.23.8 · 2025-02-21 · maintenance | `grep -rl detekt build.gradle.kts` · `Gradle io.gitlab.arturbosch.detekt plugin` | `detekt 2.0.0 alpha`: newer Kotlin support, a pre-release line | - | every-pr | The stable release is 21 months old and may not read a newer Kotlin compiler, so check compatibility before you upgrade Kotlin; adopt the 2.0.0 alphas only after a trial |
| `format` | `ktlint` | >= 1.8.0 · 2025-11-14 · active | `ktlint --version` · `brew install ktlint` | `Spotless`: runs ktlint as a build step with `spotlessCheck` | `ktlint` through `Spotless` when the build already uses it | every-pr | A second formatter; detekt formatting rules enabled beside ktlint |
| `types` | Built-in: Kotlin compiler with `allWarningsAsErrors` and `explicitApi()` for libraries | - | Built-in | None | - | every-pr | Suppressing warnings module-wide |
| `sast` | Shared: semgrep | - | Shared | `opengrep`: a community fork with no vendor rule licence; `codeql`: data-flow analysis in CI with its Kotlin extractor | `semgrep` with `codeql` in CI where licensed | every-pr | Unreviewed rule packs; detekt treated as a security program |
| `memory-safety` | N/A: the JVM manages memory | - | - | None | - | - | - |
| `dep-audit` | Shared: osv-scanner | - | Shared | `OWASP dependency-check`: NVD-based scan with a Gradle plugin | `osv-scanner` with `dependency-check` when you need the NVD data too | every-pr + scheduled | Scanning only direct dependencies |
| `dead-code` | No maintained tool: Kotlin compiler unused warnings, IntelliJ inspections and detekt `UnusedPrivateMember` | - | - | None | - | on-demand | Treating unused public members as dead; reflection and framework entry points cause false positives |
| `unused-deps` | `dependency-analysis-gradle-plugin` | >= 3.20.3 · 2026-11-14 · active | `grep -rl dependency-analysis build.gradle.kts` · `Gradle com.autonomousapps.dependency-analysis plugin` | None | - | on-demand | Auto-applying its advice without a build |
| `complexity` | Shared: lizard | - | Shared | `detekt`: its `CyclomaticComplexMethod` and `CognitiveComplexMethod` rules you already run | - | every-pr | Blanket thresholds as correctness rules |
| `duplication` | Shared: jscpd | - | Shared | None | - | on-demand | Generated-code noise in the report |
| `api-break` | `binary-compatibility-validator` | >= 0.18.2 · 2026-09-02 · maintenance | `grep -rl binary-compatibility-validator build.gradle.kts` · `Gradle org.jetbrains.kotlinx.binary-compatibility-validator plugin` | `abiValidation`: the Kotlin Gradle plugin's experimental replacement; `japicmp`: JVM jar comparison with no Kotlin metadata | `binary-compatibility-validator` until `abiValidation` leaves experimental | every-pr | Running it for applications; committing an `.api` dump without reviewing the diff |
| `docs` | `Dokka` | >= 2.3.0 · 2026-11-05 · active | `grep -rl dokka build.gradle.kts` · `Gradle org.jetbrains.dokka plugin` | None | - | every-pr | Dokka 1.x configuration on Dokka 2 without migrating |

## Tradeoffs

### fuzz-continuous

- **clusterfuzzlite**: wins for private repositories and pull-request fuzzing; costs your own CI minutes and slower corpus handling.
- **oss-fuzz**: wins for an open-source project that wants Google-run, long campaigns; costs onboarding review and open source only.

### sast

- **opengrep**: wins on a community-owned rule format with no vendor rule licence; costs a younger project and a smaller rule set.
- **codeql**: wins on data-flow depth for Kotlin in CI; costs a build, slower runs and GitHub licensing terms.

### api-break

- **binary-compatibility-validator**: wins as the stable, widely used `apiDump` and `apiCheck` workflow; costs maintenance mode, since new features go to the Kotlin Gradle plugin.
- **abiValidation**: wins as the supported future path inside the Kotlin Gradle plugin; costs an experimental API that can change.
- **japicmp**: wins when you compare published jars across Java and Kotlin; costs no view of Kotlin-specific changes such as inline functions.
