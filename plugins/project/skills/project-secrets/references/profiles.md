# Environments and profiles

Source: https://fnox.jdx.dev/guide/profiles, /guide/config-files.

Put environment differences in `fnox.production.toml` (top-level entries there belong to the
`production` profile) or in `[profiles.production.secrets]` in `fnox.toml`. A secret
redefined in a profile replaces the whole entry.

```sh
fnox -P production exec -- ./deploy.sh
fnox -P production check
fnox profiles                         # list profiles
```

- A top-level secret in `fnox.local.toml` overrides it in every profile. Put cached
  production entries under `[profiles.production.secrets]` there.
- `FNOX_PROFILE=production` selects a profile for a session.
- A profile is a separate daemon cache entry, so it costs another approval. Group the
  commands for one environment in one `fnox exec`.
- Before you touch production values, get the user's approval. Keep them in their own vault or provider.
