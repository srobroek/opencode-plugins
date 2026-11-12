# Rotate, revoke or remove

Source: https://fnox.jdx.dev/cli/daemon/clear, /cli/remove, /cli/set, /guide/sync.

## Rotate

1. Change the value at its source.
   - 1Password: the user edits the item field in 1Password.
   - `host` or another age provider: the user runs `fnox set NAME --provider host` again.
2. Drop the cached copy: `fnox daemon clear NAME`. The next `fnox exec` reads the new value.
3. Re-sync any offline cache (`references/fnox-config.md`). `daemon clear` leaves sync
   caches in config files alone.
4. Restart long-running consumers (dev servers, workers), since they hold the old value.
5. Run `fnox check`.

CI secrets pushed with `fnox push` need the push repeated (`references/ci-github.md`).

## Revoke

Revoke at the provider. Disable or delete the key in the service that issued it, or remove
the 1Password item. fnox cannot revoke it. After a leak, rotate first and clear the cache second.

## Remove a declaration

```sh
fnox remove OLD_TOKEN --dry-run    # preview
fnox remove OLD_TOKEN              # deletes it from the config file in this directory
fnox -P staging remove OLD_TOKEN   # from one profile
```

This edits the config only. The value at a remote provider stays, so the user also deletes
the 1Password item. Then run `fnox daemon clear OLD_TOKEN`.
