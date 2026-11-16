# C# and .NET testing and quality tooling

C# and .NET have no language plugin yet. A project researches commands and versions before it adopts a tool here, and follows the install policy in [concerns.md](concerns.md): detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers. Shared tools are in [shared-tools.md](shared-tools.md).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `xUnit v3` | >= 4.0.3 · 2026-11-11 · active | `dotnet list package` · `dotnet add package xunit.v3` | `MSTest`: Microsoft's runner on Microsoft.Testing.Platform (4.5.3, MIT); `NUnit`: an existing NUnit suite (5.0.0, MIT); `TUnit`: source-generated, parallel by default (1.85.0, MIT) | - | every-pr | Mixing xunit 2.x and xunit.v3 packages in one project; the package is `xunit.v3`, whose version scheme (4.x) differs from the v2 `xunit` package |
| `assertions` | `AwesomeAssertions` | >= 9.6.0 · 2026-08-20 · active | `dotnet list package` · `dotnet add package AwesomeAssertions` | `Shouldly`: a different fluent style with readable failure messages (4.3.0, BSD-3-Clause) | - | every-pr | FluentAssertions v8 or later: its Xceed Community License needs payment for commercial use; AwesomeAssertions is the Apache-2.0 drop-in fork |
| `watch` | Built-in: `dotnet watch test` | - | Built-in | None | - | on-demand | Watching `bin` and `obj` output, which retriggers the run |
| `property` | `CsCheck` | >= 5.0.1 · 2026-11-03 · active | `dotnet list package` · `dotnet add package CsCheck` | `FsCheck`: F#-origin generators with a C# API (3.6.0, BSD-3-Clause) | - | every-pr | Unseeded runs with no saved failing seed |
| `fuzz` | `SharpFuzz` | >= 2.3.0 · 2026-06-16 · maintenance | `sharpfuzz --version` · `dotnet tool install --global SharpFuzz.CommandLine` | None | - | bounded-pr | Counting on fast fixes: releases are infrequent (2.2.0 in 2025-01, 2.3.0 in 2026-06); AFL++ as the engine is AGPL-3.0 |
| `fuzz-continuous` | No maintained tool: a scheduled CI job that runs SharpFuzz with AFL++ or libFuzzer and keeps the corpus | - | - | None | - | scheduled | Assuming ClusterFuzzLite or OSS-Fuzz covers .NET without a check |
| `mutation` | `Stryker.NET` | >= 5.1.0 · 2026-11-10 · active | `dotnet stryker --version` · `dotnet tool install dotnet-stryker` | None | - | diff-pr + scheduled | Running the whole solution on every pull request; use `--since` to scope it |
| `snapshot` | `Verify` | >= 33.5.0 · 2026-11-16 · active | `dotnet list package` · `dotnet add package Verify.XunitV3` | None | - | every-pr | Approving received files without reading them; the integration package must match the test framework |
| `component` | N/A: no UI component model by default; a Blazor project adds `bUnit` and verifies its version first | - | - | None | - | - | - |
| `concurrency` | `Coyote` | >= 1.7.11 · 2026-10-30 · active | `coyote --version` · `dotnet tool install --global Microsoft.Coyote.CLI` | None | - | scheduled | Testing code that Coyote cannot rewrite or control, such as uninstrumented native calls |
| `coverage` | `coverlet` | >= 10.1.1 · 2026-11-15 · active | `dotnet list package` · `dotnet add package coverlet.collector` | `Microsoft.Testing.Extensions.CodeCoverage`: first-party collector for Microsoft.Testing.Platform (18.12.0) | - | every-pr | Coverage thresholds as the goal; coverlet.collector on a Microsoft.Testing.Platform runner (use the coverlet.MTP package) |
| `benchmark` | `BenchmarkDotNet` | >= 0.15.8 · 2025-11-30 · active | `dotnet list package` · `dotnet add package BenchmarkDotNet` | None | - | on-demand | Debug builds; unconsumed results that the JIT removes; the last release is from 2025-11 |
| `flaky-order` | Built-in: xUnit test-collection parallelism controls (`xunit.runner.json`, `CollectionDefinition(DisableParallelization = true)`) and a seeded custom test-case orderer | - | Built-in | None | - | scheduled | Assuming a shuffle exists out of the box; retries that hide a flake without an owner |
| `integration` | Shared: testcontainers | - | Shared | None | - | every-pr | Mocked databases standing in for the real engine |
| `contract` | Shared: contracts | - | Shared | `PactNet`: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Verifying a provider only against a mock |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr | Running against production |
| `load` | Shared: k6 | - | Shared | None | - | scheduled | Load tests against an environment not sized for them |
| `lint` | Built-in: .NET SDK analyzers (Microsoft.CodeAnalysis.NetAnalyzers) with an `.editorconfig` rule set | >= 11.0.100 · 2026-11-10 · active | Built-in | None | - | every-pr | Reading the archived dotnet/roslyn-analyzers repository for releases (use NuGet); severity set to none to hide findings |
| `format` | `CSharpier` | >= 1.4.0 · 2026-11-11 · active | `dotnet csharpier --version` · `dotnet tool install csharpier` | `dotnet format`: the SDK's built-in whitespace, style and analyzer fixer | `CSharpier` for layout with `dotnet format style` for analyzer fixes | every-pr | Two tools fighting over whitespace |
| `types` | Built-in: nullable reference types with `TreatWarningsAsErrors` | - | Built-in | None | - | every-pr | `#nullable disable` and the null-forgiving operator as habits |
| `sast` | Shared: semgrep | - | Shared | `opengrep`: a community fork with no vendor rule licence; `codeql`: data-flow analysis in CI with strong C# support | `semgrep` with `codeql` in CI where licensed | every-pr | Unreviewed rule packs |
| `memory-safety` | N/A: the CLR manages memory | - | - | None | - | - | - |
| `dep-audit` | Built-in: NuGet Audit (`NuGetAudit` with `NuGetAuditMode=all`) and `dotnet list package --vulnerable --include-transitive` | - | Built-in | `osv-scanner`: one scanner across languages, reading `packages.lock.json` | - | every-pr + scheduled | Auditing only direct dependencies; warnings left unpromoted to errors |
| `dead-code` | Built-in: IDE0051, IDE0052 and IDE0060 (unused private members, unread values and unused parameters) enforced in the build | - | Built-in | None | - | every-pr | Treating unused public members as dead; the rules need `EnforceCodeStyleInBuild` |
| `unused-deps` | No maintained tool: remove a package on a branch and build, comparing `dotnet list package` with the code | - | - | None | - | on-demand | Trusting a text search as proof of reachability |
| `complexity` | Shared: lizard | - | Shared | `CA1502`: the SDK's cyclomatic complexity rule, off by default, enabled in `.editorconfig` | - | every-pr | Blanket thresholds as correctness rules |
| `duplication` | Shared: jscpd | - | Shared | None | - | on-demand | Generated-code noise in the report |
| `api-break` | Built-in: SDK package validation (`EnablePackageValidation` with `PackageValidationBaselineVersion`) | - | Built-in | `PublicApiAnalyzers`: a reviewed `PublicAPI.Shipped.txt` file (5.6.0 stable) | Package validation as the gate with `PublicApiAnalyzers` for the reviewed file | every-pr | Running it for applications; a baseline version that is not published |
| `docs` | `DocFX` | >= 2.81.0 · 2026-09-25 · active | `docfx --version` · `dotnet tool install --global docfx` | `XML documentation warnings`: `GenerateDocumentationFile` with CS1591 as errors | `DocFX` to render with XML documentation warnings as the doc lint | every-pr | Publishing without failing on broken references |

## Tradeoffs

### test-runner

- **xUnit v3**: wins as the common default with parallel collections and Microsoft.Testing.Platform support; costs a 4.x package whose scheme differs from v2 and no built-in test shuffle.
- **MSTest**: wins when you want Microsoft's runner and tooling in the SDK; costs a more attribute-heavy style.
- **NUnit**: wins when an existing suite uses it or you need its constraint model; costs a different parallelism model.
- **TUnit**: wins on source-generated discovery and parallel runs by default; costs a fast-moving major version and fewer integrations.

### sast

- **opengrep**: wins on a community-owned rule format with no vendor rule licence; costs a younger project and a smaller rule set.
- **codeql**: wins on data-flow depth for C# in CI; costs a build, slower runs and GitHub licensing terms.
