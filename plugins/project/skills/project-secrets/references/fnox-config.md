# fnox.toml for a project

Annotated reference for `fnox.toml`. Sources: https://fnox.jdx.dev/guide/config-files,
/providers/1password, /providers/age, /guide/sync.

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
or `ignore`. The 1Password provider is read-only: `fnox set` only records a reference;
see `references/store.md`. fnox resolves a provider's secrets with one `op inject`, falling back
to `op read` per secret.

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

A project may declare its own age provider when CI or collaborators need committed
ciphertext, because the global `host` key belongs to one machine. For a CI-only or solo
project with no 1Password, name the provider `proj-age`. Give it the CI key and the user's
public key as recipients (`age-keygen -y` of the user's key file). The user stores each
value with `fnox set NAME --provider proj-age` at a hidden prompt. Ciphertext in
`fnox.toml` is safe to commit. See https://fnox.jdx.dev/providers/age.
