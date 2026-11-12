# Store a credential

Source: https://fnox.jdx.dev/providers/1password, /providers/age, /cli/set, /cli/provider/discover.

## Who writes the value

The agent writes values without showing them:

- Values it generates: passwords, signing keys, dev database credentials, webhook secrets.
- Values a tool hands it:
  - `gh auth token`, `aws iam create-access-key`
  - a cloud CLI or a service's API response

The agent asks the user for values only the user has:
  - a personal key from a web console
  - a password the user chose
  - a value in someone else's account

The agent also asks before it overwrites an existing value.

A value never appears literally in a command, in a file written with an editor tool, or in
tool output. Produce it inside the command with `$(...)` or a pipe.

| Provider | Steps |
| --- | --- |
| 1Password (read-only in fnox) | See "1Password steps". |
| Headless host (`host` age) | See "Headless `host` store". |
| Local-only on macOS or Windows (keychain) | See the keychain steps below. |
| Project age provider in git | Same as `host` with `--provider proj-age`. See `references/fnox-config.md`. |

Declare the secret with `env = "exec"`. For a required secret, also add
`if_missing = "error"`. `references/fnox-config.md` shows annotated examples.

## 1Password steps

1. Create the item. Pipe a JSON template so the value stays out of the arguments:
   ```sh
   jq -n --arg v "$(<command that produces the value>)" \
     '{title:"<project> <purpose>", category:"API_CREDENTIAL", tags:["project/<project>"],
       fields:[{id:"credential", type:"CONCEALED", value:$v}]}' \
     | op item create --vault <vault> - >/dev/null
   ```
   Or use `op item create --category "API Credential" --vault <vault> --title "<project> <purpose>" --tags project/<project> "credential=$(<command>)" >/dev/null`.
   For a generated password, add `--generate-password` and leave `credential=` out.
2. To update an existing item (after the user agrees to the overwrite):
   `op item edit <item> "credential=$(<command>)" >/dev/null`, then `fnox daemon clear NAME`.
3. Never print the result. Send output to `/dev/null`, or to `--format json | jq '{id}'`.
   Never use `--reveal`.
4. For a value only the user has, create the item without the field and ask the user to fill
   `credential` in 1Password.
5. Record the reference: `fnox set NAME "<item>/credential" --provider <proj|shared>`.
   A read-only provider stores the value as the reference.
6. Run `fnox check`.

## Headless `host` store

`pace` and `work-linux` declare a global age provider `host` with
`key_file = "~/.config/fnox/age.txt"`. The project declares none. `fnox set` may write the
ciphertext into the committed `fnox.toml`, and only that host's recipient can decrypt it.
Keep it out of git with `fnox -c fnox.local.toml set NAME --provider host`.

```sh
<command that produces the value> | fnox set NAME --provider host   # tool-issued value
fnox set NAME --generate --provider host                           # generated value
```

Never pass a literal value as an argument. `--generate` refuses to replace an existing
secret unless you add `--force`. Before you use `--force`, ask the user.
For a value only the user has, the user runs `fnox set NAME --provider host`
and types it at the hidden prompt.

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
Document names, vaults and who supplies them in `docs/operations.md`, not values.
