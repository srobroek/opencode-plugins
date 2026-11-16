# Swift testing and quality tooling

Swift has no language plugin yet. A project researches commands and versions before it adopts a tool here, and follows the install policy in [concerns.md](concerns.md): detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers. Shared tools are in [shared-tools.md](shared-tools.md).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | Built-in: Swift Testing (`import Testing`) run by `swift test --xunit-output` | >= 6.4.2 · 2026-10-30 · active | Built-in | `XCTest`: UI tests, performance tests and existing suites | `Swift Testing` and `XCTest` in one target during a migration | every-pr | Porting UI or performance tests that Swift Testing does not cover |
| `assertions` | Built-in: Swift Testing `#expect` and `#require` | - | Built-in | `XCTest`: `XCTAssert*` in existing XCTest suites | - | every-pr | `#expect` on an optional you then unwrap; use `#require` |
| `watch` | `watchexec` | >= 2.8.0 · 2026-10-06 · active | `watchexec --version` · `mise use watchexec` | None | - | on-demand | Watching `.build`, which retriggers the run; there is no built-in watch mode for `swift test` |
| `property` | No maintained tool: parameterised `@Test(arguments:)` over generated inputs from a seeded generator whose seed is logged on failure | - | - | None | - | every-pr | Assuming SwiftCheck is maintained (its repository was not found); there is no shrinking |
| `fuzz` | Built-in: libFuzzer through `swiftc -sanitize=fuzzer` (Linux and open-source toolchains) | - | Built-in | None | - | bounded-pr | Assuming the Apple toolchain on macOS ships libFuzzer; fuzz targets that keep state between calls |
| `fuzz-continuous` | Shared: clusterfuzzlite | - | Shared | `oss-fuzz`: an open-source project that wants Google-run campaigns | `clusterfuzzlite` on pull requests with `oss-fuzz` for long campaigns | scheduled | Discarding the corpus between runs |
| `mutation` | `Muter` | >= 16 · 2023-09-16 · maintenance | `muter --version` · `brew install muter-mutation-testing/formulae/muter` | None | - | diff-pr + scheduled | Expecting frequent releases: the last was 16 on 2023-09-16, though the repository still gets commits; running the whole project on every pull request |
| `snapshot` | `swift-snapshot-testing` | >= 1.19.7 · 2026-10-21 · active | `grep -rl swift-snapshot-testing Package.swift` · `.package(url: "https://github.com/pointfreeco/swift-snapshot-testing", from: "1.19.7") in Package.swift` | None | - | every-pr | Recording references on one OS or device and comparing on another |
| `component` | N/A: no default UI component test tool; SwiftUI view inspection tools were not verified | - | - | None | - | - | - |
| `concurrency` | Built-in: ThreadSanitizer (`swift test --sanitize=thread`) with Swift 6 language mode and complete strict concurrency checking | - | Built-in | None | - | scheduled | Combining `thread` with the `address` sanitizer; silencing Sendable warnings with `@unchecked Sendable` |
| `coverage` | Built-in: `swift test --enable-code-coverage` with `llvm-cov` export | - | Built-in | None | - | every-pr | Coverage thresholds as the goal |
| `benchmark` | `package-benchmark` | >= 1.38.2 · 2026-11-16 · active | `grep -rl package-benchmark Package.swift` · `.package(url: "https://github.com/ordo-one/package-benchmark", from: "1.38.2") in Package.swift` | None | - | on-demand | Debug builds; comparing runs on different hardware |
| `flaky-order` | Built-in: `swift test --parallel` and `--num-workers`, the `.serialized` trait in Swift Testing, and repeated CI runs of the same suite | - | Built-in | None | - | scheduled | Assuming a built-in shuffle (the toolchain has none that was verified); retries that hide a flake without an owner |
| `integration` | No maintained tool: service containers in CI or a compose file started before `swift test`; no Swift Testcontainers binding in the shared table | - | - | None | - | every-pr | Mocked databases standing in for the real engine; an unverified third-party Testcontainers port |
| `contract` | Shared: contracts | - | Shared | `PactSwift`: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Verifying a provider only against a mock; consumer tests use `PactSwift`, provider verification uses `pact_verifier_cli` |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr | Running against production |
| `load` | Shared: k6 | - | Shared | None | - | scheduled | Load tests against an environment not sized for them |
| `lint` | `SwiftLint` | >= 0.65.1 · 2026-08-21 · active | `swiftlint --version` · `brew install swiftlint` | None | - | every-pr | Disabling rules file-wide; a `.swiftlint.yml` that nobody reviews |
| `format` | `swift-format` | >= 604.0.0 · 2026-09-16 · active | `swift format --version` · `brew install swift-format` | `SwiftFormat`: more rules and options (0.64.7, MIT) | - | every-pr | Two formatters on the same files; SwiftLint style rules that fight the formatter |
| `types` | Built-in: Swift compiler in Swift 6 language mode with `-warnings-as-errors` and complete strict concurrency | - | Built-in | None | - | every-pr | Building without `-warnings-as-errors` in CI |
| `sast` | Shared: semgrep | - | Shared | `opengrep`: a community fork with no vendor rule licence; `codeql`: data-flow analysis in CI with its Swift extractor | `semgrep` with `codeql` in CI where licensed | every-pr | Unreviewed rule packs; CodeQL for Swift needs a macOS runner |
| `memory-safety` | Built-in: AddressSanitizer and UndefinedBehaviorSanitizer (`swift test --sanitize=address,undefined`) | - | Built-in | None | - | every-pr | Running them on release builds only; trusting them for code with no unsafe or C interop |
| `dep-audit` | No maintained tool: GitHub Dependabot alerts on `Package.resolved` (SwiftPM support unverified) and a manual check of resolved versions against OSV.dev | - | - | None | - | every-pr + scheduled | Assuming `osv-scanner` reads `Package.resolved`: it is not in its supported-lockfile list |
| `dead-code` | No maintained tool: compiler unused warnings with `-warnings-as-errors` | - | - | None | - | on-demand | Making Periphery the default: its open-source line is archived (3.8.0 on 2026-07-25) |
| `unused-deps` | No maintained tool: compare the target dependencies in `Package.swift` with the `import` lines in each target | - | - | None | - | on-demand | Trusting a text search as proof of reachability |
| `complexity` | Shared: lizard | - | Shared | `SwiftLint`: its `cyclomatic_complexity` rule you already run | - | every-pr | Blanket thresholds as correctness rules |
| `duplication` | Shared: jscpd | - | Shared | None | - | on-demand | Generated-code noise in the report |
| `api-break` | Built-in: `swift package diagnose-api-breaking-changes <baseline>` | - | Built-in | None | - | every-pr | Running it for applications; a baseline that is not a released tag |
| `docs` | `DocC` | >= 6.4.2 · 2026-10-30 · active | `swift package plugin generate-documentation --help` · `.package(url: "https://github.com/swiftlang/swift-docc-plugin", from: "1.5.0") in Package.swift` | None | - | every-pr | Skipping `--warnings-as-errors` for unresolved symbol links |

## Tradeoffs

### test-runner

- **Swift Testing**: wins with macros, parameterised tests, traits and parallel execution by default; costs no UI or performance tests.
- **XCTest**: wins for UI tests, performance tests and existing suites; costs a verbose assertion API and no parameterisation.

### format

- **swift-format**: wins as the toolchain's own formatter with a small, stable rule set; costs fewer options.
- **SwiftFormat**: wins when you want more rules and configuration; costs a second ecosystem beside the toolchain.

### sast

- **opengrep**: wins on a community-owned rule format with no vendor rule licence; costs a younger project and a smaller rule set.
- **codeql**: wins on data-flow depth for Swift in CI; costs a macOS build, slower runs and GitHub licensing terms.
