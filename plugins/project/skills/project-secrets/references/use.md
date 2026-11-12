# Run commands with secrets

Source: https://fnox.jdx.dev/cli/exec, /guide/running-commands, /guide/mise-integration.

```sh
fnox exec -- bun test                                   # all secrets with env true or "exec"
fnox exec --only STRIPE_KEY -- ./script.sh              # resolve a subset (names or globs)
fnox exec --only STRIPE_KEY --redact -- ./script.sh     # mask values in piped output
fnox exec -- sh -c 'curl -H "Authorization: Bearer $SENTRY_TOKEN" "$URL"'
```

- The shell expands `$NAME` before `fnox exec` starts. When the command needs `$NAME`,
  wrap it in `sh -c '...'` with single quotes.
- Run from the project root, so every call shares one daemon cache entry. A different
  directory, `-c` or `-P` needs another approval.
- Group steps that need the same secrets in one call:
  `fnox exec -- sh -c 'bun run migrate && bun test'`.
- Never use `fnox get`, `fnox export` or `fnox env`: they print values.

## `env` setting

| `env` | Injected into |
| --- | --- |
| `"exec"` | `fnox exec` only. Use this for project secrets. |
| `true` (default) | `fnox exec` and any shell that loads the config |
| `false` | Nothing. Leases and other secrets can still read it. |

A secret with `env = true` can reach the shell that starts OpenCode, where the agent
can read it. Set `env = "exec"` on every project secret.

## mise tasks

```toml
[tasks.test]
run = "fnox exec -- bun test"
```

Pin fnox with `mise use fnox`. mise's own fnox integration is experimental, so wrap the
command in `fnox exec` instead.
