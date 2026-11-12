---
name: project-secrets
description: "Use for secrets, API keys, .env, fnox, 1Password, credentials or CI secrets: per-project vaults, cache, leases."
---

# Project secrets

Per-project secrets with fnox (https://fnox.jdx.dev/) on top of 1Password. A committed
`fnox.toml` holds references only; values stay in 1Password (or age ciphertext), are
cached in memory by the fnox daemon, and reach commands through `fnox exec`. Guidance,
not a script: ask, then do the smallest setup that fits. Verify any command with
`fnox <cmd> --help` (written against fnox 1.47) before relying on it.

## Never

- Read a value into the transcript: no `fnox get`, `fnox export`, `fnox list --values`,
  `fnox env`, `op read`, `cat` of `.env` or `fnox.local.toml`'s cached values, or `echo $KEY`.
  Check with `fnox check` and `fnox list`; consume with `fnox exec`.
- Ask the user to paste a value into chat, or pass one as an argument (shell history,
  process list). Values go in through 1Password, a hidden prompt, or stdin.
- Commit values, `.env`, `fnox.local.toml`, age identities or service-account tokens.
- Redeclare what the host already provides (below), or set `GITHUB_*` names for push.

## Host assumptions

Check, do not assume: `fnox --version`, `fnox provider list`, `fnox config-files`, `op whoami`.
On the user's 1Password hosts the global `~/.config/fnox/config.toml` declares the
1Password provider `op`, `[daemon] enabled = true` (resolved values stay in memory for
the session, so repeated `fnox exec` calls do not ask 1Password again) and the shared
machine keys (Tavily, Exa, Firecrawl, TinyFish, Context7, Brave). Each interactive shell
loads those machine keys once at start; there is no `fnox activate` hook, so a project's
`fnox.toml` is never loaded into the shell on `cd`. Consequences:

- Global layer loads under every project. Providers and secrets merge by name and a
  later definition replaces the whole entry, so never name a project provider `op`,
  and never redeclare those shared keys. Top-level `env` and `if_missing` take the
  closest file's value, so also set them per secret.
- A machine-wide key (every shell on every host) is not a project secret: it is declared
  in the chezmoi source (`.chezmoidata/fnox.toml`). Follow `docs/secrets.md` in the
  chezmoi repository instead of this skill.
- After a value changes in 1Password, `fnox daemon clear NAME` drops the cached copy and
  the next `fnox exec` re-reads it. (`fnox get --refresh` does the same but prints the value.)
- Anything with `env = true` is in the shell that starts OpenCode, so the agent can read
  it. Give project secrets `env = "exec"` so only `fnox exec` injects them.
- On a 1Password host, `op` plus the daemon's in-memory cache (idle timeout 8h) is the
  only store. It keeps no age cache on disk.
- Headless hosts (`pace`, `work-linux`) have no 1Password. They have a global age provider
  `host` (`key_file = "~/.config/fnox/age.txt"`). The user stores each value with
  `fnox set NAME --provider host` at a hidden prompt, in the project. Give the user that
  exact command and never handle the value. Agents consume it with `fnox exec`.
  Never name a project provider `host` either.

## Fewer approvals

Each new 1Password session asks the user again. Keep it to one per session:

1. Consume only with `fnox exec`, never `op` directly. Each direct `op` call opens a new
   1Password session.
2. Run project commands from the project root, so every call loads the same config files
   and shares one daemon cache entry. A different directory, a `-c` flag or a profile is a
   separate entry and needs another approval.
3. Group commands that need the same secrets in one `fnox exec`.
4. Do not change fnox config files mid-session, because a change clears the cache.
5. If an approval fails or times out, stop and report the secret name. Never retry in a loop.

## 1. Ask

Which secrets (name, purpose, where it is created)? Who consumes each: local dev, tests,
CI, a deployed runtime? Collaborators or a CI that must read them? A cloud account (AWS)
needing temporary credentials? Is there an existing item to reference, or a new one? Does
the project need a different value per environment (profiles)?

## 2. Place the secret

| Situation | Where it lives |
| --- | --- |
| Machine or personal key used across projects (already in the global config) | Nothing in the project |
| One user, one machine, one project | Private vault, item `<project> <purpose>`, tag `project/<project>` |
| Cross-project key that CI or collaborators need | Shared vault `dev-shared`, provider `shared` |
| Project with collaborators or its own CI service account | Vault `proj-<name>`, provider `proj` |
| Any secret on a headless host (no 1Password) | Global `host` age provider: the user runs `fnox set NAME --provider host` in the project |
| Local-only generated value (dev DB password) | OS keychain: add `[providers.keychain] type = "keychain"`, `service = "fnox-<project>"` to `fnox.local.toml`, predeclare `[secrets.NAME] env = "exec"` there, then `fnox -c fnox.local.toml set NAME --generate --provider keychain` (value not shown; `set` has no `env` flag and a new entry defaults to `env = true`). macOS and Windows only; on Linux it needs a running Secret Service |

A vault per project is worth it only when access differs: service accounts are scoped to
vaults fixed at creation and cannot see Private, Personal, Employee or the default Shared
vault, so CI needs the secrets in a non-Private vault. For a solo project keep items in
Private and skip the extra vault. Use two vaults (`dev-shared` plus `proj-<name>`) when
both kinds exist. Each is its own named provider.

Always ask the user before creating a vault. Once the user agrees, run
`op vault create proj-<name>` once (the op-guard allows it). Then declare
`[providers.proj] type = "1password"`, `vault = "proj-<name>"` in the project `fnox.toml`.
Only the user creates service accounts, in 1Password.

## 3. Declare, create, fill

1. Add to `fnox.toml` (annotated examples: `references/fnox-config.md`): provider
   `proj` or `shared`, and each secret with `env = "exec"` and `if_missing = "error"` when required.
2. Store the credential as the next table shows.
3. After the user says it is filled, run `fnox check` (resolves without printing). The daemon
   caches it in memory; add a local sync cache only for offline use (`references/fnox-config.md`).
4. Use: `fnox exec -- <cmd>`, `--only NAME` to resolve a subset, or a mise task
   (`run = "fnox exec -- bun test"`). Shell expansion happens first, so use
   `fnox exec -- sh -c '... "$NAME" ...'` when the command line needs the value.
5. `.gitignore`: `fnox.local.toml`, `.fnox.local.toml`, `.env*` (keep `.env.example` with
   names only). `fnox scan` finds plaintext secrets already in the tree.
6. Document in `docs/operations.md` (names, vaults, who can fill them), not values.

### Store a credential

| Provider | Steps |
| --- | --- |
| 1Password (read-only in fnox) | 1. No item yet: the agent runs `op item create --category "API Credential" --vault <vault> --title "<project> <purpose>" --tags project/<project>` with no field values. The user fills the `credential` field in 1Password. 2. The agent records the reference: `fnox set NAME "<item>/credential" --provider <proj\|shared>`. A read-only provider stores the value as the reference. 3. The agent runs `fnox check` |
| Headless host (`host` age provider) | The user runs `fnox set NAME --provider host` and types the value at the hidden prompt |
| Local-only on macOS (keychain) | The existing keychain row in section 2 |

### Find an item

Run `fnox provider discover <provider> --tags project/<project>` (add `--json` for
machine output). It runs `op item list` through fnox and returns metadata only: IDs,
titles, tags and vault. Tag matching includes nested tags, so `project/<project>` also finds
`project/<project>/dev`. Never run `op item list` or `op item get` directly. Tag new items
`project/<project>`.

## 4. Other consumers

- GitHub Actions: `references/ci-github.md` (service account token, or `fnox push`).
- AWS in a personal org: `references/aws-leases.md`.
- Agent-side tools (`fnox mcp`): `references/mcp.md`; off unless the user wants it.
- Profiles (`fnox.<profile>.toml`, `-P`) for staging versus production.

Further reading: fnox ships its own agent skill at https://github.com/jdx/fnox/tree/main/skills/fnox.
Final checks: nothing sensitive in `git status`, `fnox check` passes, CI uses
`--non-interactive --if-missing error`, and the user knows how to rotate (change in
1Password, `fnox daemon clear NAME`, re-sync if a local cache exists, `fnox push` where used).
