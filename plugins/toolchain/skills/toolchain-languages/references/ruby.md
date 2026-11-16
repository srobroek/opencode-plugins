# Ruby testing and quality tooling

Ruby has no language plugin yet. A project researches commands and versions before it adopts a tool here, and follows the install policy in [concerns.md](concerns.md): detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers. Shared tools are in [shared-tools.md](shared-tools.md).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `RSpec` | >= 3.13.2 · 2025-10-21 · active | `bundle exec rspec --version` · `bundle add rspec --group test` | `Minitest`: the lighter runner in the standard distribution, plain Ruby assertions (6.1.0, MIT) | - | every-pr | CI without JUnit output (add `rspec_junit_formatter` 0.8.0); `should` syntax in new specs |
| `assertions` | Built-in: RSpec expectations (`expect(...).to`) or Minitest assertions | - | Built-in | None | - | every-pr | `should` syntax in new specs |
| `watch` | `watchexec` | >= 2.8.0 · 2026-10-06 · active | `watchexec --version` · `mise use watchexec` | `guard-rspec`: Ruby-native watcher with per-file spec mapping, check maintenance before you adopt it | - | on-demand | Watching `tmp` and `log`, which retriggers the run |
| `property` | `prop_check` | >= 1.0.2 · 2025-03-14 · maintenance | `bundle info prop_check` · `bundle add prop_check --group test` | `rantly`: simpler generators, an existing suite that uses it (3.0.0 from 2024-10) | - | every-pr | Unseeded runs with no saved failing seed; slow releases, so pin the version |
| `fuzz` | `Ruzzy` | >= 0.8.0 · 2026-04-27 · active | `gem list ruzzy` · `gem install ruzzy` | None | - | bounded-pr | Licence blindness: Ruzzy is AGPL-3.0-only, so check before you link it into shipped tooling; it needs clang and a libFuzzer-built Ruby |
| `fuzz-continuous` | No maintained tool: a scheduled CI job that runs Ruzzy with a kept corpus | - | - | None | - | scheduled | Assuming ClusterFuzzLite or OSS-Fuzz covers Ruby without a check |
| `mutation` | `mutant` | >= 0.17.1 · 2026-10-21 · active | `bundle exec mutant --version` · `bundle add mutant-rspec --group test` | None | - | diff-pr + scheduled | Using it in closed-source work without a commercial licence (free for open source only); it writes no mutation-testing-elements report |
| `snapshot` | `rspec-snapshot` | >= 2.2.0 · 2026-04-03 · active | `bundle info rspec-snapshot` · `bundle add rspec-snapshot --group test` | `approvals`: approval-style files (0.1.7, last release 2025-02) | - | every-pr | Updating snapshots in bulk without reading the diff |
| `component` | N/A: Ruby has no default UI component model | - | - | None | - | - | - |
| `concurrency` | No maintained tool: stress tests that repeat concurrent code in `Thread` or `Ractor` loops on a shuffled schedule | - | - | None | - | scheduled | Sleeping to provoke a race; treating one passing run as proof; ThreadSanitizer covers native extensions only |
| `coverage` | `SimpleCov` | >= 1.3.2 · 2026-09-30 · active | `bundle info simplecov` · `bundle add simplecov --group test` | None | - | every-pr | Coverage thresholds as the goal; starting SimpleCov after the code is loaded |
| `benchmark` | `benchmark-ips` | >= 2.14.0 · 2024-09-08 · maintenance | `bundle info benchmark-ips` · `bundle add benchmark-ips --group development` | None | - | on-demand | Comparing runs on a noisy machine; micro-benchmarks that skip warm-up |
| `flaky-order` | Built-in: RSpec `config.order = :random` with `--seed` and `--bisect`, and Minitest's default random order | - | Built-in | None | - | scheduled | Fixed ordering that hides a dependency between examples; retries without an owner |
| `integration` | Shared: testcontainers | - | Shared | None | - | every-pr | Mocked databases standing in for the real engine |
| `contract` | Shared: contracts | - | Shared | `pact gem`: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Verifying a provider only against a mock; the shared library table has no Ruby row, so verify the `pact` gem (2.1.2) before you adopt it |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr | Running against production |
| `load` | Shared: k6 | - | Shared | None | - | scheduled | Load tests against an environment not sized for them |
| `lint` | `RuboCop` | >= 1.92.2 · 2026-10-29 · active | `bundle exec rubocop --version` · `bundle add rubocop --group development` | `Standard`: a fixed RuboCop configuration with no rule choices (1.57.0) | - | every-pr | Generating a `rubocop_todo.yml` once and never shrinking it; running RuboCop and Standard together |
| `format` | `RuboCop` | >= 1.92.2 · 2026-10-29 · active | `bundle exec rubocop --version` · `bundle add rubocop --group development` | `Standard`: a fixed RuboCop configuration with no rule choices (1.57.0) | - | every-pr | A second formatter; Layout cops disabled and then fixed by hand |
| `types` | `Steep` | >= 2.1.0 · 2026-08-27 · active | `bundle exec steep --version` · `bundle add steep --group development` | `Sorbet`: inline signatures and a fast checker (Apache-2.0, daily releases) | - | every-pr | Generating RBS files and never type-checking them; `untyped` everywhere |
| `sast` | Shared: semgrep | - | Shared | `Brakeman`: Rails-specific scanner, Brakeman Public Use License (8.1.0); `codeql`: data-flow analysis in CI with Ruby support | `semgrep` with `Brakeman` for a Rails application | every-pr | Brakeman on non-Rails code; its licence is not an open-source licence |
| `memory-safety` | N/A: the interpreter manages memory | - | - | None | - | - | - |
| `dep-audit` | `bundler-audit` | >= 0.9.3 · 2025-11-28 · maintenance | `bundle exec bundler-audit --version` · `bundle add bundler-audit --group development` | `osv-scanner`: one scanner across languages, reading `Gemfile.lock` | `bundler-audit` with `osv-scanner` for a second advisory source | every-pr + scheduled | Skipping `bundler-audit update`, which leaves the advisory database stale |
| `dead-code` | `debride` | >= 1.15.2 · 2026-04-20 · active | `gem list debride` · `gem install debride` | `RuboCop`: `Lint/UselessAssignment` and `Lint/UnusedMethodArgument` for local dead code | - | on-demand | Treating output as proof: it is heuristic and misses metaprogramming and `send` calls |
| `unused-deps` | No maintained tool: remove a gem on a branch and run the test suite, comparing `Gemfile` with the code | - | - | None | - | on-demand | Trusting a text search as proof of reachability; gems loaded by `Bundler.require` |
| `complexity` | Shared: lizard | - | Shared | `flog`: an ABC-style score per method (4.9.4); `RuboCop`: `Metrics/CyclomaticComplexity` and `Metrics/PerceivedComplexity` you already run | - | every-pr | Blanket thresholds as correctness rules |
| `duplication` | `flay` | >= 2.14.5 · 2026-11-11 · active | `gem list flay` · `gem install flay` | `jscpd`: a token-based detector for every language, shared | - | on-demand | Generated code and specs in the report |
| `api-break` | No maintained tool: diff the public RBS or Sorbet RBI signatures between the last release and the branch in review | - | - | None | - | every-pr | Release automation mistaken for API compatibility evidence |
| `docs` | `YARD` | >= 0.9.45 · 2026-07-14 · active | `bundle exec yard --version` · `bundle add yard --group development` | `RDoc`: ships with Ruby, simpler markup | - | every-pr | Running without `yard stats --list-undoc` to see undocumented public methods |

## Tradeoffs

### test-runner

- **RSpec**: wins on expressive specs, matchers, and tooling such as `--bisect` and `--seed`; costs a DSL to learn and heavier startup.
- **Minitest**: wins for plain-Ruby tests and fast startup; costs fewer matchers and a thinner plugin ecosystem.

### property

- **prop_check**: wins on shrinking and a maintained API; costs slow releases.
- **rantly**: wins for suites already using it; costs the last release in 2024-10.

### lint

- **RuboCop**: wins when the team chooses its own cops; costs configuration upkeep.
- **Standard**: wins for a no-debate rule set; costs no rule choices.

### format

- **RuboCop**: wins as one tool for lint and layout; costs configuration upkeep.
- **Standard**: wins for a fixed layout; costs no style options.

### types

- **Steep**: wins with RBS signature files in separate `.rbs` files, kept in step with the standard library signatures; costs fewer editor integrations.
- **Sorbet**: wins on speed, gradual typing and the Rails ecosystem; costs inline `sig` annotations and RBI generation.

### sast

- **Brakeman**: wins on Rails-specific checks with few false positives; costs Rails-only coverage and a source-available licence.
- **codeql**: wins on data-flow depth in CI; costs a build, slower runs and GitHub licensing terms.

### complexity

- **lizard**: wins as one cyclomatic metric with a baseline across languages; costs no Ruby-specific scoring.
- **flog**: wins on an ABC-style score tuned for Ruby; costs no cyclomatic number.
- **RuboCop**: wins when cops already run in CI; costs thresholds per cop, not a baseline gate.
