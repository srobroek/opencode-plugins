# Shell testing and quality concerns

Checked 2026-11-16.

Rows follow the spec in
[concerns.md](../../toolchain-languages/references/concerns.md). Shared tools are in
[shared-tools.md](../../toolchain-languages/references/shared-tools.md).

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `bats` (bats-core with bats-support, bats-assert, bats-file) | >= 1.14.0 · 2026-07-21 · active | `bats --version` · `mise use bats` | `shellspec`: the scripts must run under dash, zsh or busybox, or you want built-in mocks | A script ships for several interpreters: bats for the Bash suite, ShellSpec for the matrix | every-pr | shUnit2 and bash_unit: smaller ecosystems, no JUnit report; `bats --jobs` needs GNU parallel |
| `assertions` | Built-in: `bats-assert` 2.2.4 with `bats-support` (`assert_output`, `assert_success`, `assert_line`) | - | `bats --version` · `mise use bats` | None | - | every-pr | Raw `[ ]` tests with no failure message; `bats-assert` needs `bats-support` loaded first |
| `watch` | `watchexec` | >= 2.8.0 · 2026-10-06 · active | `watchexec --version` · `mise use watchexec` | None | - | on-demand | Watching `.git` or generated output, which retriggers the run; use `watchexec -e sh,bats -- bats test` |
| `property` | No maintained tool: seeded `$RANDOM` table tests that print the seed on failure | - | - | None | - | - | Unseeded random input: a failure cannot be replayed |
| `fuzz` | N/A: no coverage-guided fuzzer for shell; hostile-input tables cover the risk | - | - | None | - | - | - |
| `fuzz-continuous` | N/A: no coverage-guided fuzzer for shell | - | - | None | - | - | - |
| `mutation` | No maintained tool: a forced-fault loop that flips `-eq`/`-ne`, and-or operators, exit codes or deletes a statement, runs the bats suite under `timeout`, then restores the file with git | - | - | None | - | diff-pr + scheduled | `bashrs mutate`: a stub that reports a made-up kill rate |
| `snapshot` | `bats` with `diff` against `fixtures/*.expected` | >= 1.14.0 · 2026-07-21 · active | `bats --version` · `mise use bats` | None | - | every-pr | Updating an expected file to make a test pass without reading the diff |
| `component` | N/A: shell scripts have no UI component model | - | - | None | - | - | - |
| `concurrency` | N/A: shell scripts have no race detector; test lock files and traps with parallel bats runs | - | - | None | - | - | - |
| `coverage` | `kcov` | >= 43 · 2024-07-23 · maintenance | `kcov --version` · `brew install kcov` | `bashcov`: Ruby is available and Bash is 4 or newer | - | every-pr | Gating on a percentage; kcov on macOS is unverified, run it in Linux CI |
| `benchmark` | `hyperfine` | >= 2.0.0 · 2026-10-07 · active | `hyperfine --version` · `mise use hyperfine` | None | - | on-demand | Timing with `time` once: one sample is noise |
| `flaky-order` | `bats` with `--jobs` and repeated runs | >= 1.14.0 · 2026-07-21 · active | `bats --version` · `mise use bats` | `shellspec`: the suite is already ShellSpec and needs `--random` | - | scheduled | Tests that share a fixed path in `/tmp`; use `BATS_TEST_TMPDIR` |
| `integration` | `bats` with real binaries in `BATS_TEST_TMPDIR` | >= 1.14.0 · 2026-07-21 · active | `bats --version` · `mise use bats` | None | - | every-pr | Tests that write outside `BATS_TEST_TMPDIR` or touch the user's home |
| `contract` | N/A: shell scripts have no independently deployed consumers; see `api-break` for CLI contracts | - | - | None | - | - | - |
| `api-schema` | N/A: shell scripts serve no API schema | - | - | None | - | - | - |
| `load` | N/A: scripts are not load tested; use `hyperfine` for a throughput question | - | - | None | - | - | - |
| `lint` | `shellcheck` with `-x --severity=style` and the named optional checks `check-extra-masked-returns`, `check-set-e-suppressed`, `check-unassigned-uppercase`, `deprecate-which`, `quote-safe-variables` | >= 0.11.0 · 2025-08-04 · maintenance | `shellcheck --version` · `brew install shellcheck` | `checkbashisms`: scripts with a `#!/bin/sh` shebang; `sh -n`: always, as the syntax check for the declared interpreter (`bash -n` and `zsh -n` likewise) | Always add the syntax check for the declared interpreter; add `checkbashisms` for `#!/bin/sh` | every-pr | ShellCheck on zsh scripts: it has no zsh support, use `zsh -n` |
| `format` | `shfmt` with `-d -ln bash` | >= 3.14.1 · 2026-09-06 · active | `shfmt --version` · `mise use shfmt` | None | - | every-pr | shfmt on zsh: it has no zsh support |
| `types` | N/A: shell is untyped; `set -u` plus ShellCheck catch unset and misused variables | - | - | None | - | - | - |
| `sast` | `shellcheck` | >= 0.11.0 · 2025-08-04 · maintenance | `shellcheck --version` · `brew install shellcheck` | `semgrep`: you need shell rules beyond ShellCheck, which are few and unverified; `gitleaks`: secrets in scripts, see shared tools | Add `gitleaks` for secrets in every repository | every-pr | Treating a clean ShellCheck run as proof that command construction is safe |
| `memory-safety` | N/A: the shell manages memory | - | - | None | - | - | - |
| `dep-audit` | N/A: scripts have no resolved dependency set; pin external CLIs by version in `mise.toml` | - | - | None | - | - | - |
| `dead-code` | `shellcheck` for SC2034 (unused variable) and SC2329 (function never invoked) | >= 0.11.0 · 2025-08-04 · maintenance | `shellcheck --version` · `brew install shellcheck` | None | - | every-pr | SC2329 on ShellCheck older than 0.11.0: the check does not exist |
| `unused-deps` | N/A: scripts declare no dependencies | - | - | None | - | - | - |
| `complexity` | No maintained tool: review any function over about 40 lines or with deep nesting | - | - | None | - | - | - |
| `duplication` | Shared: jscpd | - | Shared | None | - | scheduled | - |
| `api-break` | `bats` CLI contract tests that pin flags, exit codes and stdout | >= 1.14.0 · 2026-07-21 · active | `bats --version` · `mise use bats` | None | - | every-pr | Changing a flag or exit code without a changed contract test |
| `docs` | `shdoc` plus a `--help` usage text in every script | >= 1.4 · 2026-06-01 · active | `command -v shdoc` · `git clone https://github.com/reconquest/shdoc && make -C shdoc install` | None | - | every-pr | Usage text that is not covered by a test |

## Tradeoffs

### test-runner

- **bats**: wins when the scripts are Bash and you want JUnit output, `--jobs` and the assert and file helper libraries; costs Bash-only tests and GNU parallel for `--jobs`
- **shellspec**: wins when you test dash, zsh, busybox or POSIX behaviour, or want built-in mocks; costs a slower run, a DSL to learn and a last tag from 2021

### lint

- **sh -n**: wins as a zero-install syntax check for the declared interpreter (`bash -n`, `zsh -n`); costs no lint rules, so it catches only parse errors
- **shellcheck**: wins on Bash and POSIX scripts with the broadest rule set; costs no zsh support
- **checkbashisms**: wins when a `#!/bin/sh` script must stay POSIX; costs a second tool for one shebang
- **syntax check**: wins because it runs the real interpreter's parser, including zsh; costs it finds syntax errors only

### sast

- **shellcheck**: wins on injection and quoting bugs at no extra install; costs few security-specific rules
- **semgrep**: wins when you add custom rules; costs the rule set for shell is small and unverified
- **gitleaks**: wins on committed secrets; costs it reads no code logic

## Language-specific

| Topic | Tool | Note |
| --- | --- | --- |
| Command mocks | PATH stub directory | Put stub executables first on `PATH` inside `BATS_TEST_TMPDIR` |
| zsh scripts | `zsh -n` and `zsh script` from bats | Bats runs Bash; ShellCheck and shfmt do not read zsh |
| Hostile inputs | bats table tests | Cover spaces, newlines, a leading `-`, globs, empty, long and invalid UTF-8 values |
