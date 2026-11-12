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
# Providers: distinct names. Never `op` or `host` (the global config owns them).
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
# Optional secret: only reference items that exist. The user's shells do not load project
# secrets, but anyone who runs `fnox activate` retries a secret that resolves to nothing at
# every prompt.
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

## Headless hosts: the `host` age store

`pace` and `work-linux` have no 1Password. Their global config declares an age provider
`host` (`key_file = "~/.config/fnox/age.txt"`), so the project declares none. Do not name a
project provider `host` or `op`: a same-named project entry replaces the global one.

The user stores each value, and the agent does not see it.

```sh
fnox set NAME --provider host    # hidden prompt
```

Declare the secret with `env = "exec"` and consume it with `fnox exec`. `fnox set` may
write the ciphertext into the committed `fnox.toml`. Only the host's recipient can decrypt
it, so other machines and CI cannot read it. Keep it out of git with
`fnox -c fnox.local.toml set NAME --provider host`.

## Local sync cache (opt-in, offline only)

The global daemon already keeps resolved values in memory, so most projects need no
cache file. Add one only when reads must work offline or survive a reboot without
1Password. It is opt-in, not the default. A 1Password host has no age provider, so the project
declares its own in `fnox.local.toml`, encrypted to a key the user creates deliberately:

```toml
# fnox.local.toml (gitignored)
[providers.local-age]
type = "age"
recipients = ["age1..."]          # age-keygen -y <key file>
key_file = "~/.config/fnox/age.txt"
```

```sh
age-keygen -o ~/.config/fnox/age.txt     # once per machine, by the user (mode 600)
fnox sync -p local-age --local-file            # writes the cache
fnox sync -p local-age --local-file --force    # refresh after a vault change (never automatic)
fnox sync -p local-age --local-file --dry-run  # preview; KEYS or --filter <regex> narrow it
```

Writes `fnox.local.toml` with, per secret, a `[secrets.NAME.sync]` table (`provider`,
`value` ciphertext). Reads then use the cache offline, with no 1Password prompt. Run it
from the project directory without `-c`. The cache is skipped in CI. Only sync items
that exist.

## Values stored in git (no vault)

A project may still declare its own age provider when CI or collaborators need committed
ciphertext, because the global `host` key belongs to one machine. For a CI-only or solo
project with no 1Password, use an age provider with the CI key and the
user's public key as recipients (`age-keygen -y` of the user's key file), name it
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

The op-guard allows `op item create` only without field values.

```sh
op item create --category "API Credential" --vault proj-myapp \
  --title "myapp stripe" --tags project/myapp
fnox set STRIPE_KEY "myapp stripe/credential" --provider proj   # records the reference
fnox provider discover proj --tags project/myapp                 # metadata only
```

Then the user types the value into the `credential` field. Do not use assignment
statements with the value. A short reference like `Item/field` needs `vault` on the
provider. Ask first, then create a vault with `op vault create proj-myapp`. The user
creates service accounts in 1Password.
