# Java testing and quality tooling

Java has no language plugin yet. A project researches commands and versions before it adopts a tool here, and follows the install policy in [concerns.md](concerns.md): detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers. Shared tools are in [shared-tools.md](shared-tools.md).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `JUnit Jupiter` | >= 6.1.3 · 2026-08-07 · active | `grep -rl junit-jupiter build.gradle.kts pom.xml` · `testImplementation org.junit.jupiter:junit-jupiter (Maven test scope)` | `TestNG`: an existing suite that relies on its suite XML and group dependencies | - | every-pr | Mixing JUnit 4 and Jupiter without the vintage engine; failing to publish XML reports for CI |
| `assertions` | `AssertJ` | >= 3.27.7 · 2026-01-24 · active | `grep -rl assertj build.gradle.kts pom.xml` · `testImplementation org.assertj:assertj-core` | `Truth`: Google's fluent assertions, an existing Truth suite (1.4.5); `Hamcrest`: only where Mockito or Spring APIs take matchers (3.0) | - | every-pr | Mixing AssertJ and Hamcrest `assertThat` imports in one file; JUnit `assertEquals` on collections, which hides the diff |
| `watch` | Built-in: Gradle continuous build (`gradle test --continuous`) | - | Built-in | `Maven`: no built-in watch, so use `watchexec -e java -- mvn test` (2.8.0) | - | on-demand | Continuous builds on a task graph that includes slow integration tests |
| `property` | `jqwik` | >= 1.10.2 · 2026-10-10 · active | `grep -rl jqwik build.gradle.kts pom.xml` · `testImplementation net.jqwik:jqwik` | None | - | every-pr | Upgrading JUnit before you check that jqwik's engine supports that JUnit platform; unseeded failures with no saved seed |
| `fuzz` | `Jazzer` | >= 0.30.0 · 2026-02-24 · active | `grep -rl jazzer build.gradle.kts pom.xml` · `testImplementation com.code-intelligence:jazzer-junit` | None | - | bounded-pr | Fuzz targets that do I/O or keep state between calls; a release cadence that has slowed (last release 2026-02-24), so pin the version |
| `fuzz-continuous` | Shared: clusterfuzzlite | - | Shared | `oss-fuzz`: an open-source project that wants Google-run campaigns | `clusterfuzzlite` on pull requests with `oss-fuzz` for long campaigns | scheduled | Discarding the corpus between runs |
| `mutation` | `PIT` | >= 1.30.2 · 2026-11-05 · active | `grep -rl pitest build.gradle.kts pom.xml` · `Gradle plugin info.solidsoft.pitest or Maven org.pitest:pitest-maven` | `Arcmutate`: paid extensions for diff-scoped runs and extra mutators; `pitest-mutation-testing-elements-plugin`: third-party plugin that writes the mutation-testing-report-schema (0.7.1) | `PIT` with `pitest-mutation-testing-elements-plugin` when `quality_test_compare` reads the reports | diff-pr + scheduled | Running the whole project on every pull request; comparing scores with other tools |
| `snapshot` | `ApprovalTests.Java` | >= 31.0.0 · 2026-06-18 · active | `grep -rl approvaltests build.gradle.kts pom.xml` · `testImplementation com.approvaltests:approvaltests` | None | - | every-pr | Approving a new file without reading it; non-deterministic output in the golden file |
| `component` | N/A: Java has no default UI component model | - | - | None | - | - | - |
| `concurrency` | `Lincheck` | >= 3.7 · 2026-07-29 · active | `grep -rl lincheck build.gradle.kts pom.xml` · `testImplementation org.jetbrains.lincheck:lincheck` | `jcstress`: litmus tests of the JVM memory model and JIT reordering (OpenJDK, last tag 0.16 from 2023) | `Lincheck` for your own thread-safe classes, `jcstress` for low-level lock-free code | scheduled | Sleeping to provoke a race; treating one passing run as proof |
| `coverage` | `JaCoCo` | >= 0.8.16 · 2026-10-26 · active | `grep -rl jacoco build.gradle.kts pom.xml` · `Gradle jacoco plugin or Maven org.jacoco:jacoco-maven-plugin` | None | - | every-pr | Coverage thresholds as the goal; excluding code to lift the number |
| `benchmark` | `JMH` | >= 1.37 · 2023-08-03 · maintenance | `grep -rl jmh build.gradle.kts pom.xml` · `implementation org.openjdk.jmh:jmh-core` | None | - | on-demand | Benchmarks without warm-up forks; dead-code elimination left unchecked (consume results with Blackhole) |
| `flaky-order` | Built-in: JUnit random orderers (`MethodOrderer.Random` with a logged seed) and Surefire `runOrder=random` | - | Built-in | `Gradle test-retry plugin`: reruns a failed test to detect flakes | JUnit random order for ordering bugs, the retry plugin to flag and quarantine a flake with an owner | scheduled | Retries that hide a flake without an owner |
| `integration` | Shared: testcontainers | - | Shared | None | - | every-pr | Mocked databases standing in for the real engine |
| `contract` | Shared: contracts | - | Shared | `Pact JVM`: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Verifying a provider only against a mock |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr | Running against production |
| `load` | Shared: k6 | - | Shared | `Gatling`: a JVM team that writes scenarios in code | - | scheduled | Load tests against an environment not sized for them |
| `lint` | `PMD` | >= 7.29.0 · 2026-10-30 · active | `grep -rl pmd build.gradle.kts pom.xml` · `Gradle pmd plugin or Maven org.apache.maven.plugins:maven-pmd-plugin` | `Checkstyle`: convention and Javadoc rules (14.4.0, LGPL-2.1); `SpotBugs`: bytecode bug patterns (4.10.5, LGPL-2.1) | `PMD` with `SpotBugs` when you want bytecode-level bug patterns too | every-pr | A rule set copied unreviewed; suppressing rules file-wide |
| `format` | `Spotless` | >= 3.11.0 · 2026-11-02 · active | `grep -rl spotless build.gradle.kts pom.xml` · `Gradle com.diffplug.spotless or Maven com.diffplug.spotless:spotless-maven-plugin` | `google-java-format`: Google style as a standalone formatter (2.0.0); `palantir-java-format`: wider lines and lambda-friendly layout (2.102.0) | Spotless runs exactly one formatter step | every-pr | Two formatters on the same files |
| `types` | `Error Prone` | >= 2.52.0 · 2026-11-02 · active | `grep -rl errorprone build.gradle.kts pom.xml` · `Gradle net.ltgt.errorprone plugin or Maven com.google.errorprone:error_prone_core` | `NullAway`: null-safety as an Error Prone plugin (0.14.3, MIT) | `Error Prone` with `NullAway` when the code uses JSpecify or similar nullness annotations | every-pr | Running Error Prone on JDK 17 or later without the required `--add-exports` flags |
| `sast` | Shared: semgrep | - | Shared | `opengrep`: a community fork with no vendor rule licence; `codeql`: data-flow analysis in CI | `semgrep` with `codeql` in CI where licensed | every-pr | Unreviewed rule packs; SpotBugs treated as a security program |
| `memory-safety` | N/A: the JVM manages memory | - | - | None | - | - | - |
| `dep-audit` | Shared: osv-scanner | - | Shared | `OWASP dependency-check`: NVD-based scan with Gradle and Maven plugins (13.0.0, Apache-2.0) | `osv-scanner` with `dependency-check` when you need the NVD data too | every-pr + scheduled | Running dependency-check without an NVD API key; scanning only direct dependencies |
| `dead-code` | No maintained tool: PMD unused-private rules (`UnusedPrivateField`, `UnusedPrivateMethod`, `UnusedLocalVariable`) and IDE inspections | - | - | None | - | on-demand | Treating unused public members as dead; reflection and framework entry points cause false positives |
| `unused-deps` | `dependency-analysis-gradle-plugin` | >= 3.20.3 · 2026-11-14 · active | `grep -rl dependency-analysis build.gradle.kts` · `Gradle com.autonomousapps.dependency-analysis plugin` | `maven-dependency-plugin`: `dependency:analyze` for Maven builds | - | on-demand | Auto-applying its advice without a build; Maven's analysis misses reflection use |
| `complexity` | Shared: lizard | - | Shared | `PMD`: cyclomatic and cognitive complexity rules you already run | - | every-pr | Blanket thresholds as correctness rules |
| `duplication` | Shared: jscpd | - | Shared | `PMD CPD`: a Java-aware token detector that ships with PMD | - | on-demand | Generated-code noise in the report |
| `api-break` | `japicmp` | >= 0.27.0 · 2026-11-04 · active | `grep -rl japicmp build.gradle.kts pom.xml` · `Gradle me.champeau.gradle.japicmp or Maven com.github.siom79.japicmp:japicmp-maven-plugin` | `Revapi`: richer API model and configurable ignores (release cadence slow, verify before adoption) | - | every-pr | Comparing against an unpublished baseline; running it for applications that expose no library API |
| `docs` | Built-in: Javadoc (`javadoc -Xdoclint:all`) | - | Built-in | None | - | every-pr | Doclint turned off to silence warnings |

## Tradeoffs

### assertions

- **AssertJ**: wins as the fluent default with rich collection and exception diffs; costs a dependency beyond JUnit.
- **Truth**: wins when an existing suite uses it or you prefer its subject API; costs a smaller ecosystem.
- **Hamcrest**: wins only where Mockito or Spring APIs take matchers; costs weaker failure messages and a dated API.

### mutation

- **PIT**: wins as the standard JVM tool with Gradle and Maven plugins and incremental history; costs slow runs on large code and no native schema output.
- **Arcmutate**: wins when you need diff-scoped runs and more mutators and can pay; costs a commercial licence.
- **pitest-mutation-testing-elements-plugin**: wins when `quality_test_compare` must read PIT results; costs a third-party plugin to track against PIT releases.

### lint

- **PMD**: wins for source-level rules on code quality, unused code and complexity; costs rules that overlap with Checkstyle and Error Prone.
- **Checkstyle**: wins for codebase conventions and Javadoc checks; costs style-only coverage, not bug finding.
- **SpotBugs**: wins for bug patterns found in bytecode, such as null dereference and concurrency mistakes; costs a compile step first and false positives to triage.

### format

- **Spotless**: wins as the build integration that checks and applies one formatter step; costs a plugin per build tool, not a formatter itself.
- **google-java-format**: wins when Google style is the house style; costs no style options.
- **palantir-java-format**: wins when you want wider lines and tidier lambda chains; costs a deviation from the common Google style.

### sast

- **opengrep**: wins on a community-owned rule format with no vendor rule licence; costs a younger project and a smaller rule set.
- **codeql**: wins on data-flow depth for Java in CI; costs a build, slower runs and GitHub licensing terms.
