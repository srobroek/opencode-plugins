# safety

Guards for the shell tool in OpenCode V2: hard gates for commands that should never run unreviewed,
permission checks for commands that destroy work, a gate that keeps shipped migrations append-only,
an `external_directory` check for directory flags, a PR close-keyword rewrite, a package-vetting
advisory, and redaction of secret environment values from tool output. Ported from the omp-plugins `safety` package.

Every check reads the command with the shared shell parser (`@srobroek/opencode-lib`), not a regex
over the tool call. A hazard quoted as data (`grep 'rm -rf $X'`, a commit message, a here-document
written to a file, a `bun -e` fixture) never trips a check. One run through `sudo`, `env`,
`timeout`, `bash -c`, `eval`, `xargs`, a here-document fed to a shell, or a command substitution does.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/safety'
```

Needs `git` on `PATH`. The branch check also uses `gh`. Without `gh`, the merged-PR signal is
absent, so a squash-merged branch asks instead of passing.

## Hard gates

These run in `tool.hook("execute.before")` and throw. The model gets the message as the tool error,
and the command does not run.

| Id | Refuses |
| --- | --- |
| `indirection` | `rm`, `rmdir`, `dd`, `shred`, `truncate`, `unlink`, `wipefs` or `mkfs*` whose operand is `$VAR`, `${VAR}`, `$(…)` or a backtick expression. The one exception: a quoted variable after a bare `--` (`rm -r -- "$tmp_dir"`). Substitutions are never exempt. |
| `remote-exec` | A fetch (`curl`, `wget`, `fetch`, `http`, `xh`) piped into `sh`/`bash`/`zsh`/… at any later pipeline stage. A shell, `source`, `.` or `eval` running a fetch's output (`bash -c "$(curl …)"`, `bash <(curl …)`, `eval "$(curl …)"`). `nc`/`ncat` with `-e`, `--exec` or `--sh-exec`. |
| `attribution` | `git commit` (or `dgit commit`) whose `-m`, `--message`, `--trailer` or `-F`/`--file` message names an AI assistant. That covers a `Co-authored-by` trailer naming Claude, Codex, GPT, Copilot, Cursor, Devin, Gemini, Anthropic or OpenAI, a `Generated with …` line, and an `@anthropic.com`/`@openai.com` noreply address. A `-F` file is read from disk, and the gate also reads what earlier commands in the same call wrote into it. `-F -` reads the command's here-document. |
| `worktree-tmp` | `git worktree add` with a path under `/tmp` or `/private/tmp`. Relative paths resolve against the call's directory. Also `wt switch\|new\|co\|agent` naming such a path. |
| `git-defender` | The Git Defender CLI (`git defender …`, `git-defender`) in any command position. Only the user runs it. |
| `op-guard` | The 1Password CLI `op` (also `op.exe` or a path ending in `/op`) in any command position, with any subcommand except `op whoami`, `op --version`, `--help`, `op vault create <name>`, `op vault list` (names and ids only) and the `opAllow` prefixes. Each direct call opens a new 1Password session and prompts the user, so the refusal points to `fnox exec -- <cmd>` and `fnox provider discover <provider> --tags project/<name>`. `op item create` and `op item edit` pass when no secret appears in the command text. Values may come from stdin (`-`, a pipe), a `--template` file, `--generate-password`, or an assignment whose value is made of expansions only (`"credential=$TOKEN"`, `"password=$(cmd)"`; `"credential=sk-abc$X"` is refused). A literal value passes only for `[text]`, `[url]`, `[email]`, `[date]`, `[monthYear]` and `[phone]` fields and the built-in `username`, `url` and `notesPlain`. A literal for an untyped field, `[password]`, `[concealed]`, `password` or `credential`, or a here-document or here-string with literal text, is refused, as is `--reveal`. So is a pipe whose feeding stage writes a literal: `echo`, `printf` (a `%s` filled from an expansion passes), `jq -n --arg` or `--argjson` with a literal value, or `cat` of a literal here-document. |
| `op-guard` (fnox) | `fnox get`, `fnox export`, `fnox env`, `fnox list --values` (`-V`), and `fnox exec` running `env`, `printenv`, `export -p`, a bare `set` or `declare -x`. They print secret values into the transcript. Also `fnox set`, by what the provider stores. A value reaches `fnox set` only for a provider that every definition marks as a store. The guard reads every fnox config file on the path from the call's directory to the filesystem root (`fnox.toml`, `.fnox.toml`, their `.local` and profile files, all profiles whether active or not, and a `root = true` does not stop the search) plus `~/.config/fnox/config.toml`. A provider's name never counts. It is not a store when any definition has another type or none, no definition exists, a file does not parse or uses `import`, `-c`/`--config` names an expanded path, a missing or unparsable file, a file with `import`, or more than one file, or the command could change the directory fnox runs in (`cd`, `pushd`, `popd`, `env -C`, `sudo -D`, `chroot`, a `-C`/`--chdir`/`--directory`-style flag, or a command name made of an expansion); only a command with no directory change uses the call's directory. A literal `-c <file>` (not one of the searched names `fnox.toml`, `fnox.local.toml` and the like, which resolve as above) is read together with the global config, and every definition in those two must be a store. The executor and config-write rules run on the top-level command and on everything `fnox exec` or `sh -c` runs, with the same pipe, redirect and write-target analysis. `-P`/`--profile` and `FNOX_PROFILE` change nothing, since every profile is already read. 
## Limits

The guard catches honest mistakes in the common forms of a command and refuses the forms it cannot follow. It is not a sandbox against a command built to evade it. A planned `secret_store` tool will take value handling out of the shell.
