# Store a credential

Source: https://fnox.jdx.dev/providers/1password, /providers/age, /cli/set, /cli/provider/discover.

The user types each value, in 1Password or at a hidden prompt. The agent does not touch values.

| Provider | Steps |
| --- | --- |
| 1Password (read-only in fnox) | The agent creates an empty item and records the reference. See "1Password steps". |
| Headless host (`host` age) | The user runs `fnox set NAME --provider host` in the project and types the value at the hidden prompt. |
| Local-only on macOS or Windows (keychain) | See the keychain steps below. |
| Project age provider in git | The user runs `fnox set NAME --provider proj-age`. See `references/fnox-config.md`. |

Declare the secret with `env = "exec"`. For a required secret, also add
`if_missing = "error"`. `references/fnox-config.md` shows annotated examples.

## 1Password steps

1. If no item exists, the agent creates an empty one with no field values:
   `op item create --category "API Credential" --vault <vault> --title "<project> <purpose>" --tags project/<project>`.
2. The user fills the `credential` field in 1Password.
3. The agent records the reference:
   `fnox set NAME "<item>/credential" --provider <proj|shared>`.
   A read-only provider stores the value as the reference.
4. The agent runs `fnox check`.

## Headless `host` store

`pace` and `work-linux` declare a global age provider `host` with
`key_file = "~/.config/fnox/age.txt"`. The project declares none. `fnox set` may write the
ciphertext into the committed `fnox.toml`, and only that host's recipient can decrypt it.
Keep it out of git with `fnox -c fnox.local.toml set NAME --provider host`.

## Keychain (local-only generated value)

```toml
# fnox.local.toml
[providers.keychain]
type = "keychain"
service = "fnox-<project>"

[secrets.NAME]
env = "exec"
```

```sh
fnox -c fnox.local.toml set NAME --generate --provider keychain   # value not shown
```

`fnox set` has no `env` flag and a new entry defaults to `env = true`, so predeclare the
entry as above. Keychain works on macOS and Windows. Linux needs a running Secret Service.

<a id="find"></a>

## Find an existing item

```sh
fnox provider discover proj --tags project/<project>
fnox provider discover proj --tags project/<project> --json
```

Discovery runs `op item list` through fnox. It returns metadata only and does not change
`fnox.toml`. The metadata covers:

- item IDs
- titles
- tags
- the vault

Rules:

- Tag matching includes nested tags, so `project/<project>` also finds `project/<project>/dev`.
- Without `--tags` it lists every item in the provider's vault.
- Tag new items `project/<project>`.
- Choose the field explicitly. The usual one is `credential`.
- Never run `op item list` or `op item get` directly.

## `.gitignore`

```
fnox.local.toml
.fnox.local.toml
.env*
!.env.example
```

Keep `.env.example` with names only. `fnox scan` finds plaintext secrets in the tree.
Document names, vaults and who can fill them in `docs/operations.md`, not values.
