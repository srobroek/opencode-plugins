# Testing and quality concerns

Checked 2026-11-16.

Every language fills every concern below, in this order, in its own `## Concerns` table.
`bun run concerns` (`scripts/check-concerns.ts`) fails a language whose table misses a
concern, uses a marker this page does not define, or skips a required run. Read this page
when you add a language, change a language's tool choice, or need to know which check a
project is missing.

## How to use a language's table

1. Load the language's files from [Languages](#languages). Read the row for the concern.
2. Keep the project's existing tool for the concern unless the task is a migration. Use the
   row's Default otherwise, or an alternative whose condition holds.
3. Before you run a tool, follow the [install policy](#install-policy).
4. Run each concern at the times in its Run cell. A concern you could not run is reported as
   not run, with the reason, never as a pass.

## Install policy

- Detect the tool with the first command in the row's Install cell before you rely on it.
  Detect commands never install or sync: run them before you ask.
- Detect offline: read the project's installed tree (`node_modules/.bin`, `uv pip show`,
  `go.mod` tool directives, `cargo <sub> --version`); never use a probe that falls back to
  PATH or the network.
- When it is missing, recommend the install command from the Install cell and ask the user
  for permission before you run it. Never install a tool, add a dependency or change a
  lockfile without that permission.
- Prefer the project's own tool manager: a dev dependency in the manifest (`package.json`,
  `pyproject.toml` dependency groups, `go.mod` `tool` directives, `Cargo.toml`), then
  `mise.toml`, then the system package manager.
- Use the latest release the manager offers. The Maintenance cell gives a minimum version.
  Record the version you used in the report. A project lockfile still pins what
  the project already resolved.
- When the user declines, or the tool cannot run on this platform, use the row's fallback
  where it has one and report the gap.

## Concerns

| Id | Name | Group | Definition | N/A allowed for | Run must include |
| --- | --- | --- | --- | --- | --- |
| `test-runner` | Test runner | testing | Runs, isolates, filters and reports tests, with JUnit output for CI | none | every-pr |
| `assertions` | Assertions | testing | The runner's built-in assertions plus at most one diff or matcher helper | none | every-pr |
| `watch` | Watch and test selection | testing | The red-green loop tool and affected-test selection, for local TDD | iac | on-demand |
| `property` | Property tests | testing | Checks invariants over generated inputs, with shrinking and saved failing seeds | shell, iac | - |
| `fuzz` | Fuzzing | testing | Coverage-guided fuzzing of parsers and untrusted input, with a kept corpus | shell, iac | bounded-pr |
| `fuzz-continuous` | Continuous fuzzing | testing | Long fuzz campaigns that run outside the PR | shell, iac | scheduled |
| `mutation` | Mutation | testing | Changes the code on purpose and checks that a test fails | shell, iac | diff-pr + scheduled |
| `snapshot` | Snapshots and golden files | testing | Reviewed output fixtures compared on every run | shell | - |
| `component` | Component tests | testing | A UI unit rendered in isolation in a real browser or DOM | managed, native, shell, iac | every-pr |
| `concurrency` | Concurrency and races | testing | Race detectors and schedule exploration | shell, iac | - |
| `coverage` | Coverage | testing | Line, branch and changed-line coverage, read for gaps, not as a target | iac | every-pr |
| `benchmark` | Benchmarks | testing | Repeatable performance comparisons | iac | - |
| `flaky-order` | Flaky tests and test order | testing | Shuffled order, repeated runs and quarantine with an owner | iac | scheduled |
| `integration` | Integration | testing | Tests against real dependencies: databases, brokers, real cloud resources | none | - |
| `contract` | Contracts | testing | Consumer and provider agreements between independently deployed services | shell, iac | every-pr |
| `api-schema` | API schema checks | testing | Tests generated from an API schema, run against a running server | shell, iac | - |
| `load` | Load | testing | Throughput and latency under load | shell, iac | scheduled |
| `lint` | Lint | quality | The language's linter, with the project's rule set | none | every-pr |
| `format` | Format | quality | One formatter, checked in CI and applied on edit | none | every-pr |
| `types` | Types and static analysis | quality | Type checks and compiler-level static analysis | shell | every-pr |
| `sast` | Security static analysis | quality | Security rules over source code | none | - |
| `memory-safety` | Memory safety and undefined behaviour | quality | Sanitizers, interpreters and checkers for memory errors and undefined behaviour | managed, shell, iac | - |
| `dep-audit` | Dependency audit | quality | Known vulnerabilities in resolved dependencies | shell | every-pr + scheduled |
| `dead-code` | Dead code | quality | Unreachable or unused code across the project | none | - |
| `unused-deps` | Unused dependencies | quality | Declared dependencies that nothing imports | shell | - |
| `complexity` | Complexity | quality | Cognitive and cyclomatic complexity per function, gated against a baseline | iac | - |
| `duplication` | Duplication | quality | Copied code blocks | none | - |
| `api-break` | Public API breaks | quality | Breaking changes to a published library's or module's public interface | shell | every-pr |
| `docs` | Docs generation | quality | API reference generated from source, with doc lint | shell | every-pr |
| `iac-plan` | Plan and change review | iac | The planned infrastructure change, rendered for review on the PR | none | every-pr |
| `iac-drift` | Drift | iac | Differences between the code and the deployed infrastructure | none | scheduled |
| `iac-cost` | Cost | iac | Cost estimate of the planned change | none | - |

Every language fills the testing and quality groups. Only a language of kind `iac` fills
the iac group. A language without a UI component model says `N/A` for `component`.

## Surface concerns

Checks that depend on the product surface, not the language. A project fills them for each
surface it ships, in [surfaces.md](surfaces.md), whatever its language. The N/A column is
`none` here: a surface's N/A choices are in [Surfaces](#surfaces).

| Id | Name | Group | Definition | N/A allowed for | Run must include |
| --- | --- | --- | --- | --- | --- |
| `e2e` | End-to-end | surface | Deterministic whole-flow tests through the real UI, API or CLI; smoke on PRs, full matrix scheduled | none | every-pr + scheduled |
| `visual` | Visual regression | surface | Screenshot comparison against reviewed baselines | none | diff-pr |
| `a11y` | Accessibility | surface | Automated rules plus accessibility-tree snapshots | none | every-pr |
| `journey` | Journey validation | surface | Agent-driven validation of human-readable user journeys from the journeys plugin | none | release + on-demand |

## Surfaces

Surfaces file: `plugins/toolchain/skills/toolchain-languages/references/surfaces.md`

| Surface | Id | N/A allowed for |
| --- | --- | --- |
| Web UI | `web` | none |
| Mobile app | `mobile` | none |
| Desktop app | `desktop` | none |
| HTTP API | `http-api` | visual, a11y |
| Command-line tool | `cli` | visual, a11y |

## Kinds

| Kind | Meaning |
| --- | --- |
| `managed` | Garbage-collected or interpreted; memory safety is the runtime's job |
| `native` | Compiled to machine code with manual or ownership-based memory |
| `shell` | Shell scripts |
| `iac` | Infrastructure as code |

## Languages

| Language | Id | Kind | Skill | Files |
| --- | --- | --- | --- | --- |
| TypeScript and JavaScript | `typescript` | managed | `lang-typescript-libraries` | `plugins/lang-typescript/skills/lang-typescript-libraries/references/testing.md`, `plugins/lang-typescript/skills/lang-typescript-libraries/references/quality.md` |
| Python | `python` | managed | `lang-python-libraries` | `plugins/lang-python/skills/lang-python-libraries/references/testing.md`, `plugins/lang-python/skills/lang-python-libraries/references/quality.md` |
| Go | `go` | managed | `lang-go-libraries` | `plugins/lang-go/skills/lang-go-libraries/references/testing.md`, `plugins/lang-go/skills/lang-go-libraries/references/quality.md` |
| Rust | `rust` | native | `lang-rust-libraries` | `plugins/lang-rust/skills/lang-rust-libraries/references/testing.md`, `plugins/lang-rust/skills/lang-rust-libraries/references/quality.md` |
| Shell | `shell` | shell | `shell-language` | `plugins/toolchain/skills/shell-language/references/concerns.md` |
| Terraform and OpenTofu | `terraform` | iac | `terraform-language` | `plugins/toolchain/skills/terraform-language/references/concerns.md` |
| AWS CDK | `cdk` | iac | `aws-guidance` | `plugins/aws/skills/aws-guidance/references/cdk.md` |
| Java | `java` | managed | `toolchain-languages` | `plugins/toolchain/skills/toolchain-languages/references/java.md` |
| Kotlin | `kotlin` | managed | `toolchain-languages` | `plugins/toolchain/skills/toolchain-languages/references/kotlin.md` |
| C# and .NET | `dotnet` | managed | `toolchain-languages` | `plugins/toolchain/skills/toolchain-languages/references/dotnet.md` |
| Ruby | `ruby` | managed | `toolchain-languages` | `plugins/toolchain/skills/toolchain-languages/references/ruby.md` |
| PHP | `php` | managed | `toolchain-languages` | `plugins/toolchain/skills/toolchain-languages/references/php.md` |
| Swift | `swift` | native | `toolchain-languages` | `plugins/toolchain/skills/toolchain-languages/references/swift.md` |
| C and C++ | `cpp` | native | `toolchain-languages` | `plugins/toolchain/skills/toolchain-languages/references/cpp.md` |

Java, Kotlin, .NET, Ruby, PHP, Swift and C/C++ have no language plugin yet: their files
document the choices, and a project still researches commands and versions before it adopts
them. Tools shared by every language are in [shared-tools.md](shared-tools.md).

## Run tokens

| Token | Meaning |
| --- | --- |
| `every-pr` | Runs in the required CI gate on every pull request, and locally before hand-off |
| `diff-pr` | Runs on every pull request, scoped to the changed code |
| `bounded-pr` | Runs on every pull request with a time or input bound |
| `scheduled` | Runs in a scheduled workflow, with `workflow_dispatch` for a manual run |
| `release` | Runs before a release or publish |
| `on-demand` | Runs when a task needs it: a performance change, an audit, an incident |

Join tokens with ` + `, for example `diff-pr + scheduled`. A diff-scoped job blocks the merge
only on code paths the project names as critical; elsewhere it reports.

## Surface file format

`surfaces.md` has a `Checked YYYY-MM-DD.` line, then one `## <surface-id>` section per row of
[Surfaces](#surfaces), in that order. Each section holds a table with the language header
below and one row per surface concern, in the order of [Surface concerns](#surface-concerns).
Cells follow the [cell rules](#cells), with these differences: `Inherits:` is not allowed, and
`N/A:` is allowed only for the concerns in the surface's N/A column. An optional
`### Tradeoffs` in the section has one `#### <concern-id>` per concern with two or more
alternatives, each with `- **tool**: wins when ...; costs ...` bullets.

## Table format

Each language file has a `Checked YYYY-MM-DD.` line, then these sections in order:

1. `## Concerns`: the canonical rows for this file, in the order above, with exactly this
   header:

   ```markdown
   | Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
   ```

2. `## Tradeoffs`: one `### <concern-id>` per concern with two or more alternatives, with one
   bullet per tool: `- **tool**: wins when ...; costs ...`.
3. `## Language-specific`: optional, the language's own rows (HTTP mocks, factories, cloud
   emulators), in any table shape. It never repeats a canonical concern.

A language may split its rows over several files, for example testing rows in `testing.md`
and quality rows in `quality.md`. Each concern appears in exactly one file.

### Cells

| Column | Allowed values |
| --- | --- |
| Concern | The concern id in backticks |
| Default | A backticked tool name, optionally followed by a short note, `Built-in: <feature>`, `Shared: <shared-tool-id>`, `Inherits: <language-id>`, `N/A: <reason>`, only where the concern allows N/A for this kind, `No maintained tool: <fallback>` |
| Maintenance | `>= <minimum version> · <latest release date YYYY-MM-DD> · <status>`, status one of `active`, `maintenance`, `beta`, `pre-1.0`, `preview`. `-` for Shared, Inherits, N/A and No maintained tool; `-` or the full form for Built-in. A deprecated or archived tool is never a Default |
| Install | `` `<detect command>` · `<install command>` `` for a tool. `Built-in`, `Shared`, `Inherits`, or `-` for N/A and No maintained tool |
| Alternatives | `None`, or `tool: condition` items separated by `; ` |
| Use both when | When to combine the Default with an alternative, or `-` |
| Run | Run tokens joined by ` + `; must include the concern's required tokens unless the Default is N/A |
| Avoid | What not to do, and why, or `-` |

`Shared:` points to a row in [shared-tools.md](shared-tools.md) that lists the concern.
`Inherits:` takes another language's row for the same concern, for example CDK inherits
TypeScript's linter; it never points at a row that is itself Inherits or N/A.
