# Inspect and diagnose

Source: https://fnox.jdx.dev/cli/ (check, list, config-files, provider, doctor, scan, daemon).

```sh
fnox check                     # config valid; required secrets resolve; prints no values
fnox check --all               # also resolve secrets with if_missing warn or ignore
fnox list                      # names, providers; no values
fnox list --sources            # adds the config file that defines each secret
fnox config-files              # files loaded, nearest first, then the global config
fnox provider list             # providers for the active profile
fnox provider test proj        # connect and authenticate (--all tests every provider)
fnox doctor                    # config, providers, environment; resolves no values
fnox scan --values --staged    # staged files that contain a real secret value
```

`fnox check` resolves secrets, so it can trigger an approval. `fnox doctor` and
`fnox provider test` check the connection only. A pass does not prove an item exists.

## Failures

| Symptom | Cause and fix |
| --- | --- |
| Approval denied, locked or timed out | Stop. Report the secret name to the user. Do not retry in a loop. |
| Authentication required | `op` is not signed in. Ask the user to unlock 1Password. `op whoami` shows the session. |
| Unknown secret vault | A short reference (`Item` or `Item/field`) needs `vault` on the provider. Set it, or use a full `op://vault/item/field`. |
| Item or vault not found | Check names with `fnox provider discover <provider> --tags project/<name>` and the identity's vault access. |
| Unknown provider | Compare `fnox provider list` with the secret's `provider`. A project provider named `op` or `host` replaces the global one. |
| A rotation does not show | `fnox daemon clear NAME`, then rerun. |
| Different value in one directory | A `fnox.local.toml` entry overrides it. Use `fnox list --sources`. |
| `no identity matched` or identity file not found (`host`, age) | The host's `~/.config/fnox/age.txt` does not match the value's recipient. The user stores it again with `fnox set NAME --provider host`. |
