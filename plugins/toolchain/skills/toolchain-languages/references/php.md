# PHP testing and quality tooling

PHP has no language plugin yet. A project researches commands and versions before it adopts a tool here, and follows the install policy in [concerns.md](concerns.md): detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers. Shared tools are in [shared-tools.md](shared-tools.md).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `PHPUnit` | >= 13.4.7 · 2026-11-13 · active | `vendor/bin/phpunit --version` · `composer require --dev phpunit/phpunit` | `Pest`: expressive syntax on top of PHPUnit (v5.3.6, MIT) | `PHPUnit` classes and `Pest` tests in one suite | every-pr | PHPUnit 13 on a PHP older than 8.4.1 (Packagist `require`); missing `--log-junit` output in CI |
| `assertions` | Built-in: PHPUnit assertions (`assertSame`, `assertEquals`) | - | Built-in | `Pest`: expectation API (`expect(...)->toBe`) on top of PHPUnit | - | every-pr | `assertEquals` where `assertSame` is meant; loose comparison hides type bugs |
| `watch` | `watchexec` | >= 2.8.0 · 2026-10-06 · active | `watchexec --version` · `mise use watchexec` | `phpunit-watcher`: PHPUnit-specific watcher, verify its maintenance before you adopt it | - | on-demand | Watching `vendor`, which retriggers the run |
| `property` | `Eris` | >= 1.3.0 · 2026-10-16 · active | `composer show giorgiosironi/eris` · `composer require --dev giorgiosironi/eris` | None | - | every-pr | Unseeded runs with no saved failing seed |
| `fuzz` | `PHP-Fuzzer` | >= 0.0.11 · 2025-05-21 · pre-1.0 | `composer show nikic/php-fuzzer` · `composer require --dev nikic/php-fuzzer` | None | - | bounded-pr | Treating it as stable: it is an alpha with low activity (last release 2025-05-21) |
| `fuzz-continuous` | No maintained tool: a scheduled CI job that runs PHP-Fuzzer with a kept corpus | - | - | None | - | scheduled | Assuming ClusterFuzzLite or OSS-Fuzz covers PHP without a check |
| `mutation` | `Infection` | >= 0.35.11 · 2026-11-15 · active | `vendor/bin/infection --version` · `composer require --dev infection/infection` | None | - | diff-pr + scheduled | Running without a coverage driver; the whole project on every pull request (use `--git-diff-filter`) |
| `snapshot` | `spatie/phpunit-snapshot-assertions` | >= 5.4.0 · 2026-04-29 · active | `composer show spatie/phpunit-snapshot-assertions` · `composer require --dev spatie/phpunit-snapshot-assertions` | None | - | every-pr | Updating snapshots in bulk without reading the diff; its `require` lists PHPUnit up to 13 |
| `component` | N/A: PHP has no default UI component model | - | - | None | - | - | - |
| `concurrency` | No maintained tool: stress tests that repeat concurrent code (parallel, Swoole or Fibers) on a shuffled schedule | - | - | None | - | scheduled | Sleeping to provoke a race; PHP's shared-nothing request model hides most races, so test shared state in caches, files and databases |
| `coverage` | `PCOV` | >= 1.0.12 · 2026-07-21 · active | `php -m` · `pecl install pcov` | `Xdebug`: path and branch coverage, step debugging | `PCOV` in CI for speed, `Xdebug` locally for debugging | every-pr | Both drivers loaded together; Xdebug left on in CI for line coverage only |
| `benchmark` | `PHPBench` | >= 1.7.0 · 2026-06-08 · active | `vendor/bin/phpbench --version` · `composer require --dev phpbench/phpbench` | None | - | on-demand | Comparing runs with Xdebug loaded |
| `flaky-order` | Built-in: PHPUnit `--order-by=random` with `--random-order-seed` | - | Built-in | None | - | scheduled | Fixed ordering that hides a dependency between tests; retries without an owner |
| `integration` | Shared: testcontainers | - | Shared | None | - | every-pr | Mocked databases standing in for the real engine |
| `contract` | Shared: contracts | - | Shared | `pact-php`: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Verifying a provider only against a mock; the shared library table has no PHP row, and `pact-foundation/pact-php` is at an alpha (11.0.0-alpha2), so verify it before you adopt it |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr | Running against production |
| `load` | Shared: k6 | - | Shared | None | - | scheduled | Load tests against an environment not sized for them |
| `lint` | `PHP_CodeSniffer` | >= 4.0.4 · 2026-08-06 · active | `vendor/bin/phpcs --version` · `composer require --dev squizlabs/php_codesniffer` | `PHPMD`: design smells, unused code and complexity (3.0.0, BSD-3-Clause); `Rector`: automated refactoring rules, run as a dry run (2.8.5, MIT) | `PHP_CodeSniffer` with `PHPMD` for design smells | every-pr | The stale `squizlabs` repository for releases (the maintained one is PHPCSStandards, same Packagist name); a copied rule set |
| `format` | `PHP-CS-Fixer` | >= 3.95.30 · 2026-11-09 · active | `vendor/bin/php-cs-fixer --version` · `composer require --dev friendsofphp/php-cs-fixer` | `phpcbf`: the fixer that ships with PHP_CodeSniffer | - | every-pr | Two fixers with different rule sets on the same files |
| `types` | `PHPStan` | >= 2.3.6 · 2026-11-15 · active | `vendor/bin/phpstan --version` · `composer require --dev phpstan/phpstan` | `Psalm`: taint analysis and a different inference engine (7.7.0, MIT) | `PHPStan` for types with `Psalm` for taint analysis | every-pr | A baseline file that only grows; a low rule level kept forever |
| `sast` | Shared: semgrep | - | Shared | `opengrep`: a community fork with no vendor rule licence; `Psalm`: taint analysis with `--taint-analysis` | `semgrep` with `Psalm` taint analysis | every-pr | Assuming CodeQL covers PHP (it does not) |
| `memory-safety` | N/A: the PHP engine manages memory | - | - | None | - | - | - |
| `dep-audit` | Built-in: `composer audit` | - | Built-in | `osv-scanner`: one scanner across languages, reading `composer.lock` | - | every-pr + scheduled | Auditing without a committed `composer.lock` |
| `dead-code` | `dead-code-detector` | >= 1.4.2 · 2026-09-18 · active | `composer show shipmonk/dead-code-detector` · `composer require --dev shipmonk/dead-code-detector` | None | - | on-demand | Framework entry points reached by reflection or annotations reported as dead without a configured provider |
| `unused-deps` | `composer-dependency-analyser` | >= 1.8.4 · 2025-11-25 · active | `vendor/bin/composer-dependency-analyser --version` · `composer require --dev shipmonk/composer-dependency-analyser` | None | - | every-pr | Ignoring its shadow-dependency report: it finds used packages that `composer.json` does not declare |
| `complexity` | Shared: lizard | - | Shared | `PHPMD`: cyclomatic and NPath complexity rules; `phpmetrics`: HTML report of metrics (2.11.0, MIT) | - | every-pr | Blanket thresholds as correctness rules |
| `duplication` | Shared: jscpd | - | Shared | None | - | on-demand | `sebastian/phpcpd`: archived since 2023 and unmaintained |
| `api-break` | `Roave BackwardCompatibilityCheck` | >= 8.27.0 · 2026-10-26 · active | `vendor/bin/roave-backward-compatibility-check --version` · `composer require --dev roave/backward-compatibility-check` | None | - | every-pr | Running it for applications; comparing against a tag that was never released |
| `docs` | `phpDocumentor` | >= 3.10.0 · 2026-05-13 · active | `phpdoc --version` · `curl -fsSL -o phpDocumentor.phar https://github.com/phpDocumentor/phpDocumentor/releases/latest/download/phpDocumentor.phar` | None | - | every-pr | Generating docs without failing on errors in the DocBlocks |

## Tradeoffs

### lint

- **PHP_CodeSniffer**: wins for coding standards and custom sniffs; costs style-only coverage, not bug finding.
- **PHPMD**: wins for design smells, unused code and complexity; costs noisy defaults that need tuning.
- **Rector**: wins for rule-based upgrades and refactors, run as a dry run in CI; costs a rule set to curate and a lint role only in dry-run mode.

### complexity

- **lizard**: wins as one cyclomatic metric with a baseline across languages; costs no PHP-specific scoring.
- **PHPMD**: wins when its rules already run in CI; costs thresholds per rule, not a baseline gate.
- **phpmetrics**: wins for a browsable report of maintainability metrics; costs no gating.

### sast

- **opengrep**: wins on a community-owned rule format with no vendor rule licence; costs a younger project and a smaller rule set.
- **Psalm**: wins for taint analysis that follows user input to sinks; costs a second type checker next to PHPStan.

## Language-specific

| Tool | Use | Maintenance | Install |
| --- | --- | --- | --- |
| `Deptrac` | Architecture layer rules: which namespaces may depend on which | >= 4.7.2 · 2026-09-15 · active | `vendor/bin/deptrac --version` · `composer require --dev deptrac/deptrac` |
