# Where a secret lives

Source: https://fnox.jdx.dev/guide/config-files, /providers/1password.

| Situation | Where it lives |
| --- | --- |
| Machine or personal key used across projects (already in the global config) | Nothing in the project |
| One user, one machine, one project | Private vault, item `<project> <purpose>`, tag `project/<project>` |
| Cross-project key that CI or collaborators need | Shared vault `dev-shared`, provider `shared` |
| Project with collaborators or its own CI service account | Vault `proj-<name>`, provider `proj` |
| Any secret on a headless host (no 1Password) | Global `host` age provider |
| Local-only generated value | OS keychain (`references/store.md`) |

A machine-wide key (every shell on every host) is not a project secret. It belongs in the
chezmoi source (`.chezmoidata/fnox.toml`). Follow `docs/secrets.md` in that repository.

## When a vault is worth it

A vault pays off only when access differs. A service account sees only the vaults fixed at
its creation. It cannot see these vaults:

- Private
- Personal
- Employee
- the default Shared vault

So CI needs its secrets in a non-Private vault. For a solo project, keep items in Private.
When both needs exist, use two vaults (`dev-shared` plus `proj-<name>`).

## Create a per-project vault

1. Ask the user. Never create a vault unasked.
2. Once the user agrees, run `op vault create proj-<name>` one time (the op-guard allows it).
3. Declare the provider in the project `fnox.toml`:

```toml
[providers.proj]
type = "1password"
vault = "proj-myapp"
# account = "my.1password.com"   # only when several accounts are signed in
```

4. The user creates any service account in 1Password.

## Provider names

The global config owns `op` and, on headless hosts, `host`. A project provider with the
same name replaces the whole global entry. Name project providers `proj`, `shared` or
`proj-age` instead. Never redeclare the shared machine keys. They cover these services:

- Tavily
- Exa
- Firecrawl
- TinyFish
- Context7
- Brave

Top-level `env` and `if_missing` take the closest file's value, so set them on each secret.
