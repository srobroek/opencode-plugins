---
name: project-secrets
description: "Use for secrets, API keys, .env, fnox, 1Password, credentials or CI secrets: per-project vaults, cache, leases."
---

# Project secrets

Per-project secrets with fnox (https://fnox.jdx.dev/) on top of 1Password. A committed
`fnox.toml` holds references only; values stay in 1Password (or age ciphertext), are
cached locally in a gitignored file, and reach commands through `fnox exec`. Guidance,
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
On the user's 1Password hosts the global `~/.config/fnox/config.toml` declares only the
age providers `age` and `age-work` (the sync cache; identity `~/.config/fnox/age.txt`)
and imports shared machine keys (Tavily, Exa, Firecrawl, TinyFish, Context7, Brave).
It has no 1Password provider on purpose, so shells never call `op`; a project that reads
1Password declares its own named provider. Every interactive shell runs `fnox activate`.
Consequences:

- Global layer loads under every project. Providers and secrets merge by name and a
  later definition replaces the whole entry, so never name a project provider `age`,
  `age-work` or `onepassword-producer`, and never redeclare those shared keys. Top-level
  `env` and `if_missing` take the closest file's value, so also set them per secret.
- A machine-wide key (every shell on every host) is not a project secret: it is declared
  in the chezmoi source and published with `fnox-refresh`. Follow `docs/secrets.md` in the
  chezmoi repository instead of this skill.
- Anything with `env = true` is in the shell that starts OpenCode, so the agent can read
  it. Give project secrets `env = "exec"` so only `fnox exec` injects them.
- Headless hosts (pace, work-linux) may have no fnox or 1Password. Say so and stop at
  declaring the config; do not install credentials there unprompted.

## 1. Ask

Which secrets (name, purpose, where it is created)? Who consumes each: local dev, tests,
CI, a deployed runtime? Collaborators or a CI that must read them? A cloud account (AWS)
needing temporary credentials? Is there an existing item to reference, or a new one? Does
the project need a different value per environment (profiles)?

## 2. Place the secret

| Situation | Where it lives |
| --- | --- |
| Machine or personal key used across projects (already in the global config) | Nothing in the project |
| One user, one machine, one project | Private vault, item `<project> <purpose>`, tag `<project>` |
| Cross-project key that CI or collaborators need | Shared vault `dev-shared`, provider `shared` |
| Project with collaborators or its own CI service account | Vault `proj-<name>`, provider `proj` |
| Local-only generated value (dev DB password) | Predeclare `[secrets.NAME] env = "exec"` in `fnox.local.toml`, then `fnox -c fnox.local.toml set NAME --generate --provider age` (value not shown; `set` has no `env` flag and a new entry defaults to `env = true`) |

A vault per project is worth it only when access differs: service accounts are scoped to
vaults fixed at creation and cannot see Private, Personal, Employee or the default Shared
vault, so CI needs the secrets in a non-Private vault. For a solo project keep items in
Private and skip the extra vault. Use two vaults (`dev-shared` plus `proj-<name>`) when
both kinds exist; each is its own named provider. Ask before creating any vault.

## 3. Declare, create, fill

1. Add to `fnox.toml` (annotated examples: `references/fnox-config.md`): provider
   `proj` or `shared`, and each secret with `env = "exec"` and `if_missing = "error"` when required.
2. Create the empty item without the value (`op item create --category "API Credential"
   --vault <v> --title "<title>" --tags <project>`), then tell the user which item and
   field `credential` to fill in 1Password. Alternatively the user runs
   `fnox set NAME --provider <age-provider>` themselves for age-stored values.
3. After the user says it is filled: `fnox check` (resolves without printing), then
   `fnox sync -p age --local-file --force` to refresh the offline cache.
4. Use: `fnox exec -- <cmd>`, `--only NAME` to resolve a subset, or a mise task
   (`run = "fnox exec -- bun test"`). Shell expansion happens first, so use
   `fnox exec -- sh -c '... "$NAME" ...'` when the command line needs the value.
5. `.gitignore`: `fnox.local.toml`, `.fnox.local.toml`, `.env*` (keep `.env.example` with
   names only). `fnox scan` finds plaintext secrets already in the tree.
6. Document in `docs/operations.md` (names, vaults, who can fill them), not values.

## 4. Other consumers

- GitHub Actions: `references/ci-github.md` (service account token, or `fnox push`).
- AWS in a personal org: `references/aws-leases.md`.
- Agent-side tools (`fnox mcp`): `references/mcp.md`; off unless the user wants it.
- Profiles (`fnox.<profile>.toml`, `-P`) for staging versus production.

Further reading: fnox ships its own agent skill at https://github.com/jdx/fnox/tree/main/skills/fnox.
Final checks: nothing sensitive in `git status`, `fnox check` passes, CI uses
`--non-interactive --if-missing error`, and the user knows how to rotate (change in
1Password, then re-sync, and `fnox push` where used).
