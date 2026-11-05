# Worktrees (Worktrunk)

Ask: will several agents or branches run in parallel? If yes, set up Worktrunk (the
`worktrunk` plugin skills `worktrunk-worktrees` and `worktrunk-preflight` cover usage; check
`wt config --help` for current options before writing config). Ask for the setup command
(default `just setup-worktree`; a fresh-clone `just setup` also works), and the dev command
(`just dev` or `bun run dev`) only if the project serves something.

## `.config/wt.toml` (committed)

Commands from a project file are approved once per command; editing one re-prompts. Keep
per-developer choices (commit-message agent) in user config.

```toml
pre-merge = "just check"            # same gate as CI; a failure cancels the merge

[[pre-start]]
trust = "mise trust --yes"          # first: an untrusted mise config is skipped silently
[[pre-start]]
copy-ignored = "wt step copy-ignored --require-include"
[[pre-start]]
toolchain = "mise install --yes"
[[pre-start]]
deps = "just setup-worktree"        # per worktree: installs this worktree's hook shims too

[forge]
platform = "github"                 # or gitlab
# hostname = "git.example.com"      # only for a self-hosted forge

[step.copy-ignored]
exclude = [".beads/dolt/"]          # a Dolt database must not be forked by copying

[post-start]                        # only when the project serves
dev = "wt step tether -- env PORT={{ branch | hash_port }} just dev"
[list]
url = "http://localhost:{{ branch | hash_port }}"
```

`hash_port` maps a branch to a stable port in 10000-19999, so parallel worktrees do not
collide; the tether kills the server with the worktree. An exclude beats an include, so a
user config that excludes a path cancels the project's include: report such a conflict.

## `.worktreeinclude` (committed)

Gitignore-style list; a path is copied only when it is also gitignored. The user config runs
`copy-ignored --require-include`, so without this file nothing copies and a worktree starts
cold. List what is expensive to rebuild or cannot be regenerated: `.env`, `.env.local`,
`node_modules/`, `.a11y/node_modules/`, `.venv/`, `target/`, `vendor/`, `.pytest_cache/`,
`.ruff_cache/`, `.mypy_cache/`, plus project-specific heavy directories. Rust `target/` is
repository-scoped (`ops-no-global-cargo-target`); caches (`ops-toolchain-cache-policy`).
