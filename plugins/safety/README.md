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
| `dns-delegation` | `aws route53 delete-hosted-zone` unless the command carries the `DNS_PARENT_CHECKED=1` marker (a leading assignment, or an earlier `export` in the same call). The refusal points to the DNS delegation steering: delete the parent's NS and DS record sets for the child and verify, because a dangling delegation is a subdomain-takeover risk. CloudFormation and CDK deletes of `AWS::Route53::HostedZone` are not detected. |
| `op-guard` | The 1Password CLI `op` (also `op.exe` or a path ending in `/op`) in any command position, with any subcommand except `op whoami`, `op --version`, `--help`, `op vault create <name>`, `op vault list` (names and ids only) and the `opAllow` prefixes. Each direct call opens a new 1Password session and prompts the user, so the refusal points to `fnox exec -- <cmd>` and `fnox provider discover <provider> --tags project/<name>`. `op item create` and `op item edit` pass only when they carry no value from the shell: `--generate-password`, or literal fields of the `[text]`, `[url]`, `[email]`, `[date]`, `[monthYear]` and `[phone]` types and the built-in `username`, `url` and `notesPlain`. Every value source is refused and points to [`safety_secret_store`](#secret-store-tool): stdin (`-`, a pipe, an input redirect, a here-document or here-string, or stdin a `sh -c` script, a here-document script or `fnox exec` passes down), a `--template` file, and any expanded word (`"credential=$TOKEN"`, `--vault "$V"`). A literal for an untyped field, `[password]`, `[concealed]`, `password` or `credential`, a literal here-document or here-string, or a pipe whose feeding stage writes a literal (`echo`, `printf`, `jq --arg` with a literal value, `cat` of a literal here-document) gets the literal-secret message. `--reveal` is refused. |
| `op-guard` (fnox) | `fnox get`, `fnox export`, `fnox env`, `fnox list --values` (`-V`), and `fnox exec` running `env`, `printenv`, `export -p`, a bare `set` or `declare -x`. They print secret values into the transcript. Also `fnox set` with a value, for every provider: stdin (a pipe, redirect, here-document or here-string, or stdin a script or `fnox exec` passes down), a `-` value, an expanded value or `--default`, a process substitution, `--generate` or `--from-file`. The refusal points to [`safety_secret_store`](#secret-store-tool). The reference form passes: `fnox set NAME '<item>/<field>' --provider <op-provider>`, a literal with no expansion. So does `fnox set NAME` with no value, which prompts the user. The provider type still picks the message, and a literal value or `--default` for a value-store provider is refused as a literal secret. A provider counts as a store only when every definition marks it as one. The guard reads every fnox config file on the path from the call's directory to the filesystem root (`fnox.toml`, `.fnox.toml`, their `.local` and profile files, all profiles whether active or not, and a `root = true` does not stop the search) plus `~/.config/fnox/config.toml`. A provider's name never counts. It is not a store when any definition has another type or none, no definition exists, a file does not parse or uses `import`, `-c`/`--config` names an expanded path, a missing or unparsable file, a file with `import`, or more than one file, or the command could change the directory fnox runs in (`cd`, `pushd`, `popd`, `env -C`, `sudo -D`, `chroot`, a `-C`/`--chdir`/`--directory`-style flag, or a command name made of an expansion); only a command with no directory change uses the call's directory. A literal `-c <file>` (not one of the searched names `fnox.toml`, `fnox.local.toml` and the like, which resolve as above) is read together with the global config, and every definition in those two must be a store. The executor and config-write rules run on the top-level command and on everything `fnox exec` or `sh -c` runs, with the same pipe, redirect and write-target analysis. `-P`/`--profile` and `FNOX_PROFILE` change nothing, since every profile is already read. 

## Secret-store tool

`safety_secret_store({ name, target, generate | command, config?, description? })` stores a new secret
without a shell. The value stays out of:

- every command line and environment
- logs and error messages
- the tool result and the transcript

The inputs:

- `name` is the fnox secret name, `^[A-Z][A-Z0-9_]*$`.
- `generate: { charset, bytes | length }` draws from the CSPRNG. `ascii-printable` runs from `!` to
  `~`, with no space; the other charsets are `hex`, `base64url` and `alnum`. `bytes` asks for that much
  entropy, and `length` asks for that many characters. A request under 128 bits fails.
- `command: { argv, cwd? }` runs argv with no shell. Every run asks for the `safety_secret_command`
  permission and shows argv and cwd, never output. An `allow` rule becomes an `ask`, and a `deny`
  still refuses. The value is stdout with one trailing newline trimmed. More than 64 KiB stops the
  command. A non-zero exit fails with the exit code only. The tool discards stderr.
- `target: { kind: "1password", vault, item, field?, tags?, provider? }` pipes the item JSON on stdin
  to `op item create --vault=<vault> -`. The item is an API Credential with a concealed `credential`
  field. Next the tool runs `fnox set --provider=<p> -- NAME '<item>/<field>'`. The provider is the
  named one, or the only provider that the config file and the global config define as `1password`.
  When the provider is
  uncertain, the tool fails before it runs anything. When the provider's configured vault is not
  `vault`, or is uncertain, the reference is the full `op://<vault>/<item>/<field>`.
- `target: { kind: "fnox-store", provider }` pipes the value on stdin to `fnox set --provider=<p> -- NAME`.
  fnox reads a piped value when it gets no VALUE argument. The tool accepts only a provider that the
  op-guard rule counts as a value store. It refuses a value with whitespace at either end, since fnox
  trims it. This target replaces an existing value.
- `config` names the fnox config file, `fnox.toml` in the session directory by default. The file must
  exist. The tool resolves it with symlinks followed and passes the canonical path as
  `fnox --config=<path>`, so fnox loads only that file and the global config.

The config file pins where the value goes:

1. A file outside the session directory and its repository asks for the `external_directory`
   permission, the same way the host's file tools ask. A symlink inside the project that points
   outside counts as outside.
2. The tool reads the config file and the global config once and checks the provider against those
   bytes.
3. It asks for the `safety_secret_store` permission. The resource and the metadata name the secret,
   the target, the provider and the canonical config path.
4. It obtains the value. A command's process group is killed once the command exits.
5. It reads the config again with no cached data. When the digest of the files (paths, symlink
   targets, contents) differs, or the provider fails the check, the call stops and writes nothing.

`op` and `fnox` must be on `PATH`. A set `FNOX_CONFIG_DIR` or `FNOX_CONFIG`, or an `XDG_CONFIG_HOME`
other than `~/.config`, stops the call: fnox could then read a config the tool did not check. The result is `{ name, reference, stored: true }` or `{ name, provider, stored: true }`, with no
value or length.

A failure names the stage and the exit code, never child output. The tool retries nothing, so a
refused or timed-out 1Password approval stops the call. After the store, the tool zeroes its value
buffers. Copies inside the runtime's pipe buffers stay out of its reach.

## Limits

The guard catches honest mistakes in the common forms of a command and refuses the forms it cannot
follow. It is not a sandbox against a command built to evade it. For that reason it refuses every
value-carrying `op item create|edit` and `fnox set` from the shell. The
[`safety_secret_store`](#secret-store-tool) tool does that work without a shell. It checks the fnox
config again after the value is obtained, but fnox reads the file itself.

The tool does not close one gap in the `command` source:

- What can happen: the command can start a detached process (for example with `setsid`) that leaves
  its process group. That process can change the fnox config after the recheck and before fnox reads
  it, so fnox can use another provider.
- Why it is accepted: the command prints the value, so it already has the value. The gap gives it
  nothing new. Only the `command` source has this gap, since `generate` runs no command.
- What to do: approve only commands you trust. When the secret does not come from a service, use
  `generate`.
