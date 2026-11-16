---
name: shell-language
description: Use when writing or reviewing shell scripts for portability, command safety, quoting, or testing.
---

# Shell

Quote expansions unless intentional splitting is required. Prefer arrays for
commands and arguments when the selected shell supports them.

Keep scripts compatible with their declared interpreter. Do not use Bash-only
features in POSIX `sh` scripts, and account for macOS Bash 3.2 when portability
is required.

Treat command construction, temporary files, and destructive operations as
explicit trust boundaries.

## Workflow

1. Read the shebang. It decides the interpreter for every check below.
2. Run the checks from [references/concerns.md](references/concerns.md) before
   hand-off: `shellcheck -x --severity=style`, `shfmt -d -ln bash`, the
   interpreter's syntax check (`bash -n`, `sh -n` or `zsh -n`) and the bats suite.
   Add `checkbashisms` for `#!/bin/sh`. ShellCheck and shfmt do not read zsh.
3. Put tests in `test/*.bats`, expected output in `test/fixtures/*.expected`, and
   stub commands in a directory placed first on `PATH` inside `BATS_TEST_TMPDIR`.
   Pin each script's flags, exit codes and stdout with a CLI contract test.
4. Test hostile inputs: spaces, newlines, a leading `-`, globs, empty and long
   values. Run mutation checks and repeated runs on a schedule, not on every change.
5. Install policy: detect each tool with the Install cell's first command. When it
   is missing, recommend the install command and ask permission before you run it.
   Report any check you could not run, never as a pass.
