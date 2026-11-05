# fnox.toml for a project

Sources: https://fnox.jdx.dev/guide/config-files, /providers/1password, /guide/sync,
/guide/running-commands, /guide/shell-integration, /guide/mise-integration.

## Files

| File | Commit? | Holds |
| --- | --- | --- |
| `fnox.toml` | yes | providers, secret references, targets, leases |
| `fnox.<profile>.toml` | yes | one environment (loaded only for that profile, `-P`/`FNOX_PROFILE`) |
| `fnox.local.toml` | no | the encrypted sync cache and personal overrides |

Load order: global config, then `fnox.toml`, profile files, `fnox.local.toml`, closer
directories last. `fnox config-files` lists what loaded; `fnox list --sources` shows which
file defines each secret.

## Committed `fnox.toml`

```toml
# Providers: distinct names. Never `age`, `age-work` or `onepassword-producer` (the global config owns those).
[providers.proj]               # per-project vault
type = "1password"
vault = "proj-myapp"           # omit the whole provider if the project uses only `shared`
# account = "my.1password.com" # only when several 1Password accounts are signed in

[providers.shared]             # cross-project vault
type = "1password"
vault = "dev-shared"

[secrets]
# `value` is "<item>" (field password), "<item>/<field>", or a full op://vault/item/field,
# which ignores the provider's vault. API Credential items keep the value in `credential`.
STRIPE_KEY   = { provider = "proj",   value = "myapp stripe/credential", env = "exec", if_missing = "error" }
SENTRY_TOKEN = { provider = "shared", value = "sentry/credential",       env = "exec", if_missing = "warn" }
# Optional secret: only reference items that exist. A secret that resolves to nothing is
# retried on every prompt by the shell hook.
LOG_LEVEL    = { default = "info", env = true }   # not secret: fine in the shell
```

`env`: `true` injects into the shell and `fnox exec`; `"exec"` only into `fnox exec`;
`false` never (still usable by leases and other secrets). `if_missing`: `error`, `warn`
or `ignore`. The 1Password provider is read-only: `fnox set` only records a reference
(`fnox set STRIPE_KEY "myapp stripe/credential" --provider proj`); create and edit the
item in 1Password. fnox resolves a provider's secrets with one `op inject`, falling back
to `op read` per secret.

## Profiles

Put environment differences in `fnox.production.toml` (top-level entries there belong to
the `production` profile) or `[profiles.production.secrets]`. A secret redefined in a
profile replaces the whole entry. Pick one: `fnox -P production exec -- ...`. A top-level
secret in `fnox.local.toml` overrides it in every profile, so put cached production
entries under `[profiles.production.secrets]`.

## Local sync cache

```sh
fnox sync -p age --local-file            # provider `age` from the global config
fnox sync -p age --local-file --force    # refresh after a vault change (never automatic)
fnox sync -p age --local-file --dry-run  # preview; KEYS or --filter <regex> narrow it
```

Writes `fnox.local.toml` with, per secret, a `[secrets.NAME.sync]` table (`provider`,
`value` ciphertext). Reads then use the cache offline, with no 1Password prompt. Run it
from the project directory without `-c`. The cache is skipped in CI. If the user's
global config names the sync provider differently, use that name (`fnox provider list`).
Only sync items that exist.

## Values stored in git (no vault)

For a CI-only or solo project with no 1Password: an age provider with the CI key and the
user's public key as recipients (`age-keygen -y ~/.config/fnox/age.txt`), name it
`proj-age`; the user stores each value with `fnox set NAME --provider proj-age` (hidden prompt). Ciphertext in `fnox.toml` is safe to commit. See https://fnox.jdx.dev/providers/age.

## Using it

```sh
fnox check                    # config valid, required secrets resolve; prints no values
fnox list                     # names, providers, source; no values
fnox exec -- bun test
fnox exec --only STRIPE_KEY --redact -- ./script.sh   # --redact masks piped output
fnox provider test proj
fnox doctor                   # config, providers, environment
fnox scan --values --staged   # no committed copies of real values
```

mise task: `[tasks.test] run = "fnox exec -- bun test"`; pin fnox with `mise use fnox`.
mise's own fnox integration is experimental, so wrap with `fnox exec` instead.

## Creating the 1Password item (no value in the transcript)

```sh
op item create --category "API Credential" --vault proj-myapp \
  --title "myapp stripe" --tags myapp
```

Then the user types the value into the `credential` field. Do not use assignment
statements with the value. Never create a vault or service account without asking.
