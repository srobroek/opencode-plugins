---
name: project-secrets
description: "Use for secrets, credentials, API keys, fnox, 1Password, .env, vault or rotate: store, use, inspect and rotate project secrets."
---

# Project secrets

Manage project secrets with fnox (https://fnox.jdx.dev/, written against 1.47). A committed
`fnox.toml` holds references only. Values stay in 1Password (or age ciphertext) and reach
commands through `fnox exec`. Ask the user, and do the smallest setup that fits.

## Never

- Put a value in the transcript. These commands print values, so never run them:
  - `fnox get`, `fnox export`, `fnox env`, `fnox list --values`
  - `op read`, `cat .env`, `echo $KEY`
- Run `op` directly, except a value-free `op item create` and an approved `op vault create`.
  The op-guard refuses the rest. Use `fnox exec` and `fnox provider discover` instead.
- Commit any of these:
  - values and `.env`
  - `fnox.local.toml`
  - age identities and tokens
- Ask the user to paste a value into chat, or pass one as an argument.

## Hosts

The laptop uses 1Password through fnox's `op` provider, plus the daemon's in-memory cache
(8h idle timeout). `pace` and `work-linux` have no 1Password. They have a global `host`
age store, and the user types each value with `fnox set NAME --provider host`. Check with
`fnox provider list` and `fnox config-files`.

## Fewer approvals

Each new 1Password session asks the user again. Keep it to one per session:

1. Consume only with `fnox exec`, never `op` directly. Each direct `op` call opens a
   new session.
2. Run project commands from the project root.
   - Every call loads the same config files and shares one daemon cache entry.
   - A different directory, `-c` or profile is a separate entry and needs another approval.
3. Group commands that need the same secrets in one `fnox exec`.
4. Do not change fnox config files mid-session, because a change clears the cache.
5. If an approval fails or times out, stop and report the secret name. Never retry in a loop.

## Find your task

| Task | Read |
| --- | --- |
| Run a command with secrets | `references/use.md` |
| List the declared secrets, or diagnose a failure | `references/inspect.md` |
| Store or add a credential | `references/store.md` |
| Find an existing 1Password item | `references/store.md#find` |
| Choose where a secret lives, or configure a project, shared or per-project vault | `references/vaults.md` |
| Rotate, revoke or remove a secret | `references/rotate.md` |
| Environments, staging or production | `references/profiles.md` |
| Cache values for offline use | `references/fnox-config.md` |
| GitHub Actions | `references/ci-github.md` |
| AWS temporary credentials | `references/aws-leases.md` |
| Agent-side MCP | `references/mcp.md` |

Read the reference for your task only.
